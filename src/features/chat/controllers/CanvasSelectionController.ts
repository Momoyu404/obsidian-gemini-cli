import type { App, ItemView, WorkspaceLeaf } from 'obsidian';

interface CanvasViewInternal {
  canvas?: { selection?: Set<{ id: string }> };
  file?: { path?: string };
}

import type { CanvasSelectionContext } from '../../../utils/canvas';
import { updateContextRowHasContent } from './contextRowVisibility';

/** Reduced polling interval — canvas has no selectionchange event, but changes are infrequent. */
const CANVAS_POLL_INTERVAL = 1000;

export class CanvasSelectionController {
  private app: App;
  private indicatorEl: HTMLElement;
  private inputEl: HTMLElement;
  private contextRowEl: HTMLElement;
  private onVisibilityChange: (() => void) | null;
  private storedSelection: CanvasSelectionContext | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    app: App,
    indicatorEl: HTMLElement,
    inputEl: HTMLElement,
    contextRowEl: HTMLElement,
    onVisibilityChange?: () => void
  ) {
    this.app = app;
    this.indicatorEl = indicatorEl;
    this.inputEl = inputEl;
    this.contextRowEl = contextRowEl;
    this.onVisibilityChange = onVisibilityChange ?? null;
  }

  start(): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => this.poll(), CANVAS_POLL_INTERVAL);
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.clear();
  }

  private poll(): void {
    const canvasView = this.getCanvasView();
    if (!canvasView) return;

    const canvas = (canvasView as unknown as CanvasViewInternal).canvas;
    if (!canvas?.selection) return;

    const selection: Set<{ id: string }> = canvas.selection;
    const canvasPath = (canvasView as unknown as CanvasViewInternal).file?.path;
    if (!canvasPath) return;

    const nodeIds = [...selection].map(node => node.id).filter(Boolean);

    if (nodeIds.length > 0) {
      const sameSelection = this.storedSelection
        && this.storedSelection.canvasPath === canvasPath
        && this.storedSelection.nodeIds.length === nodeIds.length
        && this.storedSelection.nodeIds.every(id => nodeIds.includes(id));

      if (!sameSelection) {
        this.storedSelection = { canvasPath, nodeIds };
        this.updateIndicator();
      }
    } else if (document.activeElement !== this.inputEl) {
      if (this.storedSelection) {
        this.storedSelection = null;
        this.updateIndicator();
      }
    }
  }

  private getCanvasView(): ItemView | null {
    const activeLeaf = (this.app.workspace as unknown as { activeLeaf?: WorkspaceLeaf }).activeLeaf ?? this.app.workspace.getMostRecentLeaf?.();
    const activeView = activeLeaf?.view as ItemView | undefined;
    if (activeView?.getViewType?.() === 'canvas' && (activeView as unknown as CanvasViewInternal).file) {
      return activeView;
    }

    const leaves = this.app.workspace.getLeavesOfType('canvas');
    if (leaves.length === 0) return null;
    const leaf = leaves.find(l => (l.view as unknown as CanvasViewInternal).file);
    return leaf ? (leaf.view as ItemView) : null;
  }

  private updateIndicator(): void {
    if (!this.indicatorEl) return;

    if (this.storedSelection) {
      const { nodeIds } = this.storedSelection;
      this.indicatorEl.textContent = nodeIds.length === 1
        ? `node "${nodeIds[0]}" selected`
        : `${nodeIds.length} nodes selected`;
      this.indicatorEl.classList.remove('geminese-hidden');
    } else {
      this.indicatorEl.classList.add('geminese-hidden');
    }
    this.updateContextRowVisibility();
  }

  updateContextRowVisibility(): void {
    if (!this.contextRowEl) return;
    updateContextRowHasContent(this.contextRowEl);
    this.onVisibilityChange?.();
  }

  getContext(): CanvasSelectionContext | null {
    if (!this.storedSelection) return null;
    return {
      canvasPath: this.storedSelection.canvasPath,
      nodeIds: [...this.storedSelection.nodeIds],
    };
  }

  hasSelection(): boolean {
    return this.storedSelection !== null;
  }

  clear(): void {
    this.storedSelection = null;
    this.updateIndicator();
  }
}
