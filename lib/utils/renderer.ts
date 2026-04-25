import type { IRenderer } from '@antv/g';
import { Renderer as CanvasRenderer } from '@antv/g-canvas';
import { Renderer as SVGRenderer } from '@antv/g-svg';

export type RenderMode = 'svg' | 'canvas';

export function selectRenderMode(nodeCount: number): RenderMode {
  return nodeCount > 800 ? 'canvas' : 'svg';
}

export function createLayerRenderer(mode: RenderMode): (layer: 'background' | 'main' | 'label' | 'transient') => IRenderer {
  return () => {
    if (mode === 'canvas') {
      return new CanvasRenderer();
    }

    return new SVGRenderer();
  };
}
