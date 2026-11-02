import { describe, expect, it } from 'vitest';
import {
  normalizeMarkdown,
  parseMarkdownNote,
  parseWikiLinks,
} from '../src/main/services/links/wiki-parser';

describe('wiki parser', () => {
  it('parses Chinese, aliased and subfolder links', () => {
    const links = parseWikiLinks('查看 [[笔记]]、[[目录/笔记]] 和 [[笔记|别名]]。');
    expect(links).toHaveLength(3);
    expect(links.map((link) => [link.target, link.alias])).toEqual([
      ['笔记', null],
      ['目录/笔记', null],
      ['笔记', '别名'],
    ]);
    expect(links.map((link) => link.raw)).toEqual(['[[笔记]]', '[[目录/笔记]]', '[[笔记|别名]]']);
  });

  it('reports 1-based line and column positions', () => {
    const markdown = '# 标题\n\n第一行 [[甲]] 和 [[目录/乙|别名]]\n';
    const links = parseWikiLinks(markdown);
    expect(links.map((link) => [link.line, link.column])).toEqual([
      [3, 5],
      [3, 13],
    ]);
  });

  it('keeps positions correct in CRLF documents', () => {
    const markdown = '# 标题\r\n\r\n甲 [[笔记]] 乙\r\n';
    const note = parseMarkdownNote('note.md', markdown);
    expect(note.links).toHaveLength(1);
    expect(note.links[0]?.line).toBe(3);
    expect(note.links[0]?.column).toBe(3);
  });

  it('excludes fenced, indented and inline code plus HTML blocks', () => {
    const markdown = [
      '# 标题',
      '',
      '正常 [[保留]]，行内 `[[行内代码]]`。',
      '',
      '```md',
      '[[围栏代码]]',
      '```',
      '',
      '    [[缩进代码]]',
      '',
      '<div>',
      '[[HTML块]]',
      '</div>',
      '',
      '> 引用 [[引用内]]',
      '',
      '- 列表 [[列表内]]',
      '  - 嵌套 [[嵌套列表]]',
      '',
      '| 列 |',
      '| --- |',
      '| [[表格内]] |',
      '',
      '**加粗 [[强调内]]**',
    ].join('\n');

    const links = parseWikiLinks(markdown);
    expect(links.map((link) => link.target)).toEqual([
      '保留',
      '引用内',
      '列表内',
      '嵌套列表',
      '表格内',
      '强调内',
    ]);
  });

  it('excludes code fences nested inside list items', () => {
    const markdown = ['- 列表 [[可见]]', '', '  ```', '  [[代码]]', '  ```'].join('\n');
    expect(parseWikiLinks(markdown).map((link) => link.target)).toEqual(['可见']);
  });

  it('ignores embeds, empty targets, nested brackets and unclosed tokens', () => {
    const markdown = '![[图片]] [[]] [[ [嵌套] ]] [[未闭合';
    expect(parseWikiLinks(markdown)).toEqual([]);
  });

  it('treats escaped brackets as plain text', () => {
    const markdown = String.raw`\[\[转义]] 与 [[真实]]`;
    expect(parseWikiLinks(markdown).map((link) => link.target)).toEqual(['真实']);
  });

  it('does not let a wiki token span a newline', () => {
    expect(parseWikiLinks('[[前\n后]]')).toEqual([]);
  });

  it('extracts the first level-1 heading as the title', () => {
    const note = parseMarkdownNote('folder/file.md', '## 二级\n\n# 我的 **笔记** `v1`\n');
    expect(note.title).toBe('我的 笔记 v1');
  });

  it('falls back to the file stem when no level-1 heading exists', () => {
    const note = parseMarkdownNote('folder/文件名.md', '## 只有二级标题\n');
    expect(note.title).toBe('文件名');
  });

  it('normalises CRLF and BOM before lexing', () => {
    expect(normalizeMarkdown('\uFEFFa\r\nb\rc')).toBe('a\nb\nc');
  });

  it('keeps duplicate occurrences as separate links', () => {
    expect(parseWikiLinks('[[甲]] 和 [[甲]]')).toHaveLength(2);
  });
});
