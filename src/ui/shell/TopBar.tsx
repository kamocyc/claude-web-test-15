import { useEffect, useRef, useState } from 'react';
import { TID } from '@e2e/testids';

import type { ProjectDocument } from '@/domain/model';
import { createEmptyProject } from '@/domain/project';
import { downloadText, pickTextFile } from '@/io/fileIO';
import { fromJson, suggestFileName, toJson } from '@/io/serialize';
import { buildKodomonokuniProject, buildOimachiProject } from '@/seed';
import { useProjectStore } from '@/store/projectStore';

import { TransportBar } from './TransportBar';
import styles from './Shell.module.css';

export interface TopBarProps {
  onMessage(text: string): void;
}

/** File menu, undo/redo, and the transport controls. */
export function TopBar({ onMessage }: TopBarProps) {
  const dispatch = useProjectStore((s) => s.dispatch);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const historyTop = useProjectStore((s) => s.history[s.history.length - 1]);
  const redoTop = useProjectStore((s) => s.redoStack[s.redoStack.length - 1]);
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useProjectStore.getState().undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        useProjectStore.getState().redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const newProject = (): void => {
    setMenuOpen(false);
    dispatch({ type: 'project/replace', doc: createEmptyProject(), label: '新規プロジェクト' });
    onMessage('新規プロジェクトを作成しました');
  };

  /**
   * Two samples now, and they are two *documents*: a project models exactly
   * one line, so loading one replaces the other rather than adding to it.
   */
  const loadSample = (build: () => ProjectDocument): void => {
    setMenuOpen(false);
    try {
      // One command, so a single Ctrl+Z puts the previous project back.
      dispatch({ type: 'project/replace', doc: build(), label: 'サンプル読込' });
      onMessage('サンプルを読み込みました');
    } catch (err) {
      // The generator can legitimately give up (e.g. no platform fits a slot).
      // Losing the menu is worse than losing the sample.
      const detail = err instanceof Error ? err.message : String(err);
      onMessage(`サンプルの生成に失敗しました — ${detail}`);
    }
  };

  const exportProject = (): void => {
    setMenuOpen(false);
    const doc = useProjectStore.getState().doc;
    downloadText(suggestFileName(doc), toJson(doc));
    onMessage('エクスポートしました');
  };

  const importProject = (): void => {
    setMenuOpen(false);
    void pickTextFile().then((picked) => {
      if (picked === undefined) return;
      const result = fromJson(picked.text);
      if (!result.ok || result.doc === undefined) {
        onMessage(`読み込みに失敗しました — ${result.errors.slice(0, 3).join(' / ')}`);
        return;
      }
      dispatch({ type: 'project/replace', doc: result.doc, label: 'インポート' });
      onMessage(`${picked.name} を読み込みました`);
    });
  };

  return (
    <header className={styles.topBar}>
      <span className={styles.brand}>鉄道運行シミュレータ</span>

      <div className={styles.menuWrap} ref={wrapRef}>
        <button type="button" data-testid={TID.menuFile} onClick={() => setMenuOpen((v) => !v)}>
          ファイル ▾
        </button>
        {menuOpen ? (
          <div className={styles.menu} role="menu">
            <button type="button" data-testid={TID.menuNewProject} onClick={newProject}>
              新規プロジェクト
            </button>
            <button
              type="button"
              data-testid={TID.menuLoadSample('oimachi')}
              onClick={() => loadSample(buildOimachiProject)}
            >
              サンプル読込 — 大井町線 (複線)
            </button>
            <button
              type="button"
              data-testid={TID.menuLoadSample('kodomonokuni')}
              onClick={() => loadSample(buildKodomonokuniProject)}
            >
              サンプル読込 — こどもの国線 (単線)
            </button>
            <button type="button" data-testid={TID.menuImport} onClick={importProject}>
              インポート
            </button>
            <button type="button" data-testid={TID.menuExport} onClick={exportProject}>
              エクスポート
            </button>
          </div>
        ) : null}
      </div>

      <div className={styles.group}>
        <button
          type="button"
          data-testid={TID.undo}
          disabled={historyTop === undefined}
          onClick={() => undo()}
          title={historyTop ? `元に戻す: ${historyTop.label}` : '元に戻す'}
        >
          ↶ 元に戻す
        </button>
        <button
          type="button"
          data-testid={TID.redo}
          disabled={redoTop === undefined}
          onClick={() => redo()}
          title={redoTop ? `やり直す: ${redoTop.label}` : 'やり直す'}
        >
          ↷ やり直す
        </button>
      </div>

      <TransportBar />
    </header>
  );
}
