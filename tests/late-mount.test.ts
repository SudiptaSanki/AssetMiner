/**
 * Late-mount detection tests — the blink.new field report scenario:
 * the page is an SPA shell at injection time; the editor (possibly inside a
 * shadow root) renders only after the user opens the Code section.
 */
import { describe, expect, it } from 'vitest';
import {
  Cm6Observer,
  deepDetectEditorObserver,
  detectEditorObserver,
  deepQuerySelectorAll,
} from '../src/core/observers';
import { GenericEditorAdapter } from '../src/core/adapters/generic-editor';
import { selectAdapter } from '../src/core/adapters/registry';

function mountCm6Editor(): HTMLElement {
  // Minimal CodeMirror-6-style editor with gutter numbers + two lines.
  const editor = document.createElement('div');
  editor.className = 'cm-editor';
  const scroller = document.createElement('div');
  scroller.className = 'cm-scroller';
  const gutters = document.createElement('div');
  gutters.className = 'cm-gutters';
  const lineNumbers = document.createElement('div');
  lineNumbers.className = 'cm-gutter cm-lineNumbers';
  const content = document.createElement('div');
  content.className = 'cm-content';
  const lines = ['const a = 1;', 'const b = 2;'];
  lines.forEach((text, i) => {
    const g = document.createElement('div');
    g.className = 'cm-gutterElement';
    g.textContent = String(i + 1);
    lineNumbers.appendChild(g);
    const line = document.createElement('div');
    line.className = 'cm-line';
    line.textContent = text;
    content.appendChild(line);
  });
  gutters.appendChild(lineNumbers);
  scroller.append(gutters, content);
  editor.appendChild(scroller);
  return editor;
}

describe('late-mounting editor detection (blink.new scenario)', () => {
  it('detects nothing before the editor renders (honest null)', () => {
    expect(detectEditorObserver(document)).toBeNull();
    expect(deepDetectEditorObserver(document)).toBeNull();
    expect(new GenericEditorAdapter().detect()).toBe(false);
    expect(selectAdapter().adapter).toBeNull();
  });

  it('binds the CM6 observer once the editor mounts (deep + shallow)', () => {
    const editor = mountCm6Editor();
    document.body.appendChild(editor);

    const shallow = detectEditorObserver(document);
    expect(shallow?.kind).toBe('cm6');
    const snap = shallow!.read();
    expect(snap?.ranges).toEqual([{ startLine: 1, endLine: 2, lines: ['const a = 1;', 'const b = 2;'] }]);

    const deep = deepDetectEditorObserver(document);
    expect(deep?.kind).toBe('cm6');
    expect(new GenericEditorAdapter().detect()).toBe(true);
    expect(selectAdapter().adapter?.id).toBe('generic-editor');

    editor.remove();
  });

  it('finds editors inside OPEN SHADOW ROOTS (deep only)', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(mountCm6Editor());

    // Shallow search cannot see it; deep search can.
    expect(detectEditorObserver(document)).toBeNull();
    const deep = deepDetectEditorObserver(document);
    expect(deep?.kind).toBe('cm6');
    const snap = deep!.read();
    expect(snap?.ranges[0]?.lines).toEqual(['const a = 1;', 'const b = 2;']);

    expect(deepQuerySelectorAll('.cm-editor').length).toBe(1);
    host.remove();
  });

  it('CM6 observer reads gutter-numbered lines through spans', () => {
    const editor = mountCm6Editor();
    // Wrap one line's text in a span like syntax highlighting does.
    const line2 = editor.querySelectorAll('.cm-line')[1]!;
    line2.textContent = '';
    const kw = document.createElement('span');
    kw.textContent = 'const';
    line2.appendChild(kw);
    line2.appendChild(document.createTextNode(' b = 2;'));

    const snap = new Cm6Observer(editor).read();
    expect(snap?.ranges[0]?.lines[1]).toBe('const b = 2;');
    editor.remove();
  });
});
