import type { BrowserWindow } from 'electron';
import { BackgroundService } from './background-service';
import { DocumentService } from './document-service';
import { ExportService } from './export-service';
import { LinkService } from './link-service';
import { RenameCoordinator } from './rename-coordinator';
import { ResourceService } from './resource-service';
import { StateService } from './state-service';
import { WorkspaceService } from './workspace-service';

export interface Services {
  workspace: WorkspaceService;
  documents: DocumentService;
  images: ResourceService;
  background: BackgroundService;
  exporter: ExportService;
  state: StateService;
  links: LinkService;
  renames: RenameCoordinator;
}

export function createServices(getWindow: () => BrowserWindow | null): Services {
  const workspace = new WorkspaceService(getWindow);
  const documents = new DocumentService(workspace);
  const links = new LinkService(workspace);
  return {
    workspace,
    documents,
    images: new ResourceService(workspace),
    background: new BackgroundService({ getWindow }),
    exporter: new ExportService(workspace),
    state: new StateService(workspace),
    links,
    renames: new RenameCoordinator(documents, links),
  };
}
