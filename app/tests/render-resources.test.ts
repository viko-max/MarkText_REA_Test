/**
 * Image reference resolution for the render pipeline.
 *
 * Windows notes routinely write relative image links with a backslash
 * (`![](assets\pixel.png)`). The resolver must normalise only the separator
 * and keep every other boundary rule unchanged: absolute paths stay rejected
 * and `..` may never leave the workspace root.
 */

import { describe, expect, it } from 'vitest';
import { classifyImageSource, resolveWorkspaceImagePath } from '../src/renderer/src/render/resources';

describe('resolveWorkspaceImagePath', () => {
  it('normalises Windows backslash separators into POSIX relative paths', () => {
    expect(resolveWorkspaceImagePath('目录/笔记.md', '../assets\\pixel.png')).toEqual({
      path: 'assets/pixel.png',
    });
    expect(resolveWorkspaceImagePath('首页.md', 'assets\\中文 图片.png')).toEqual({
      path: 'assets/中文 图片.png',
    });
    expect(resolveWorkspaceImagePath('目录/子目录/deep.md', '..\\..\\assets\\pixel.png')).toEqual({
      path: 'assets/pixel.png',
    });
  });

  it('keeps rejecting traversal above the workspace root', () => {
    expect(resolveWorkspaceImagePath('首页.md', '../outside\\secret.txt')).toEqual({
      reason: 'outside_workspace',
    });
    expect(resolveWorkspaceImagePath('目录/笔记.md', '..\\..\\secret.png')).toEqual({
      reason: 'outside_workspace',
    });
  });

  it('still rejects malformed encodings and empty targets', () => {
    expect(resolveWorkspaceImagePath('首页.md', '%E0%A4%A')).toEqual({ reason: 'invalid_encoding' });
    expect(resolveWorkspaceImagePath('首页.md', '   ')).toEqual({ reason: 'invalid_path' });
  });
});

describe('classifyImageSource', () => {
  it('keeps absolute paths unsafe on both separators', () => {
    // Drive letters are rejected by the scheme check (`C:`) before the
    // absolute-path branch; `/…` and UNC-style `\\…` reach that branch. All of
    // them stay unsafe and may never become a workspace path.
    for (const href of ['C:/secret.png', 'C:\\secret.png']) {
      expect(classifyImageSource(href, '首页.md')).toMatchObject({
        kind: 'unsafe',
        path: null,
        reason: 'blocked_scheme:c',
      });
    }
    for (const href of ['\\\\server\\share\\x.png', '/etc/secret.png']) {
      expect(classifyImageSource(href, '首页.md')).toMatchObject({
        kind: 'unsafe',
        path: null,
        reason: 'absolute_path',
      });
    }
  });

  it('classifies Windows relative references as workspace-local images', () => {
    expect(classifyImageSource('..\\assets\\pixel.png', '目录/笔记.md')).toEqual({
      kind: 'local',
      path: 'assets/pixel.png',
      url: null,
      reason: null,
    });
    expect(classifyImageSource('assets\\pixel.png', '首页.md')).toEqual({
      kind: 'local',
      path: 'assets/pixel.png',
      url: null,
      reason: null,
    });
  });

  it('still reports the workspace escape for backslash traversal', () => {
    expect(classifyImageSource('..\\outside\\secret.png', '首页.md')).toEqual({
      kind: 'unsafe',
      path: null,
      url: '..\\outside\\secret.png',
      reason: 'outside_workspace',
    });
  });
});
