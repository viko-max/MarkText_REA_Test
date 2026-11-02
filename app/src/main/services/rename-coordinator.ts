/**
 * Cross-file rename transaction.
 *
 * A rename with reference updates touches several files: the note itself and
 * every document whose `[[wikilinks]]` resolve to it. The move happens first,
 * then each rewrite is written as a compare-and-swap against the exact text the
 * plan was computed from, so an edit that landed in between refuses the write
 * instead of being overwritten.
 *
 * Because those writes are independent files, a failure part-way through is
 * undone: the already-written documents are restored to their originals in
 * reverse order, and the note is moved back to its old path. If the rollback
 * itself fails the error says so and carries both failures; no success is
 * claimed.
 */

import type { RenameDocumentRequest, RenameDocumentResult } from '../../shared/contracts';
import { AppError } from '../errors';
import { sha256Hex } from './atomic-write';
import type { DocumentService } from './document-service';
import type { LinkService } from './link-service';
import type { RenamePlan } from './links/rename-plan';

interface WrittenRewrite {
  path: string;
  originalMarkdown: string;
  rewrittenMarkdown: string;
}

type RollbackOperation = 'restore' | 'rename';

interface FailureRecord {
  operation: RollbackOperation | 'write';
  path: string;
  code: string;
  message: string;
}

export class RenameCoordinator {
  constructor(
    private readonly documents: DocumentService,
    private readonly links: LinkService,
  ) {}

  async rename(request: RenameDocumentRequest): Promise<RenameDocumentResult> {
    if (!request.updateReferences) {
      const result = await this.documents.rename(request);
      return { ...result, referencesDeferred: false };
    }

    const plan = await this.links.renamePlan(request.fromPath, request.toPath);
    await this.documents.rename({ ...request, updateReferences: false });

    const written: WrittenRewrite[] = [];
    for (const rewrite of plan.rewrites) {
      // The renamed note moved with the file, so its rewrite belongs at the new
      // path; every other document keeps its own path.
      const path =
        rewrite.documentPath === request.fromPath ? request.toPath : rewrite.documentPath;
      try {
        await this.documents.save({
          documentId: `rename:${request.documentId}`,
          path,
          markdown: rewrite.markdown,
          baseHash: sha256Hex(rewrite.originalMarkdown),
        });
      } catch (error) {
        const rollbackFailures = await this.rollback(written, request);
        this.links.invalidate();
        throw this.buildRollbackError(plan, path, error, rollbackFailures);
      }
      written.push({
        path,
        originalMarkdown: rewrite.originalMarkdown,
        rewrittenMarkdown: rewrite.markdown,
      });
    }

    this.links.invalidate();
    return {
      path: request.toPath,
      referenceEdits: plan.referenceEdits,
      skippedReferences: plan.skippedReferences,
      referencesDeferred: false,
    };
  }

  /** Restores written documents in reverse order, then moves the note back. */
  private async rollback(
    written: readonly WrittenRewrite[],
    request: RenameDocumentRequest,
  ): Promise<FailureRecord[]> {
    const failures: FailureRecord[] = [];

    for (const entry of [...written].reverse()) {
      try {
        await this.documents.save({
          documentId: `rename:${request.documentId}`,
          path: entry.path,
          markdown: entry.originalMarkdown,
          baseHash: sha256Hex(entry.rewrittenMarkdown),
        });
      } catch (error) {
        failures.push(describeFailure('restore', error, entry.path));
      }
    }

    try {
      await this.documents.rename({
        documentId: request.documentId,
        fromPath: request.toPath,
        toPath: request.fromPath,
        updateReferences: false,
      });
    } catch (error) {
      failures.push(describeFailure('rename', error, request.toPath));
    }

    return failures;
  }

  private buildRollbackError(
    plan: RenamePlan,
    failedPath: string,
    failure: unknown,
    rollbackFailures: readonly FailureRecord[],
  ): AppError {
    const details: Record<string, unknown> = {
      path: failedPath,
      referenceEdits: plan.referenceEdits,
      skippedReferences: plan.skippedReferences,
    };
    if (rollbackFailures.length === 0) {
      return new AppError(
        'conflict',
        'rename rolled back because reference updates failed',
        details,
      );
    }
    return new AppError('conflict', 'rename rollback incomplete', {
      ...details,
      failure: describeFailure('write', failure, failedPath),
      rollbackFailures: [...rollbackFailures],
    });
  }
}

function describeFailure(
  operation: FailureRecord['operation'],
  error: unknown,
  path: string,
): FailureRecord {
  return {
    operation,
    path,
    code: error instanceof AppError ? error.code : 'internal_error',
    message: error instanceof Error ? error.message : String(error),
  };
}
