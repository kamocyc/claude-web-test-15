/**
 * 路線図ビュー — the "where is every train right now" view.
 *
 * Three stacked canvases (see `useCanvasLayers`) plus a hidden DOM shadow:
 *
 *   static  — rails, station blocks, platforms, 待避線 tint, depot stubs.
 *             Redrawn on camera or document change only.
 *   dynamic — train markers. Redrawn each frame while the clock runs.
 *   overlay — hover and selection. Redrawn on pointer events.
 *
 * The component reads application state imperatively through
 * `getRenderScene()` inside the frame callback, so playing the timetable
 * causes exactly zero React renders. React is involved only for the 4 Hz
 * shadow and for layout rebuilds.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { TID } from '@e2e/testids';
import type { TrainId, TrainTypeId } from '@/domain/ids';
import type { Formation, TrainType } from '@/domain/model';
import { entityList } from '@/domain/units';
import type { EntityRef } from '@/validation/types';
import {
  clampCamera,
  createCamera,
  fitXToBounds,
  type Camera2D,
  type ScaleLimits,
  type Viewport,
  type WorldBounds,
} from '../canvas/camera';
import { HitRects } from '../canvas/hit';
import { registerFrameTask } from '../canvas/rafLoop';
import { getTheme } from '../canvas/theme';
import { layerStyles, useCanvasLayers } from '../canvas/useCanvasLayers';
import { usePanZoom } from '../canvas/usePanZoom';
import { getRenderScene, useSceneGeneration, useShadowScene } from '../scene';
import { registerDigest } from '../testHooks';
import type { LineViewProps, RenderDigest } from '../types';
import {
  drawLineDynamic,
  drawLineOverlay,
  drawLineStatic,
  lineStationPositions,
  lineTrainPositions,
} from './draw';
import { computeLineLayout, LANE_HEIGHT, type LineLayout } from './layout';
import { LineViewShadow } from './LineViewShadow';

/** Only x zooms freely; lane height is clamped to a legible band. */
const LIMITS: ScaleLimits = {
  minScaleX: 0.004,
  maxScaleX: 4,
  minScaleY: 14,
  maxScaleY: 48,
};

const EMPTY_BOUNDS: WorldBounds = { minX: 0, maxX: 1000, minY: 0, maxY: 2 };

export function LineViewCanvas(props: LineViewProps) {
  const { onSelect, highlightDutyId, showDeadhead = true, className } = props;

  const layers = useCanvasLayers();
  const generation = useSceneGeneration();
  const shadowScene = useShadowScene();

  const cameraRef = useRef<Camera2D>(createCamera({ scaleY: LANE_HEIGHT }));
  const boundsRef = useRef<WorldBounds>(EMPTY_BOUNDS);
  const viewportRef = useRef<Viewport>({ width: 0, height: 0 });
  const hits = useRef(new HitRects<TrainId>(256));
  const hovered = useRef<TrainId | undefined>(undefined);
  const fitted = useRef(false);
  const lastDrawKey = useRef('');

  // -- layout ---------------------------------------------------------------
  const layout: LineLayout | undefined = useMemo(() => {
    const scene = getRenderScene();
    if (!scene) return undefined;
    return computeLineLayout(scene.doc);
    // Rebuilt on document/index change only — never on a clock tick.
  }, [generation]);

  const lookups = useMemo(() => {
    const scene = getRenderScene();
    const trainTypes = new Map<TrainTypeId, TrainType>();
    const formations = new Map<string, Formation>();
    if (scene) {
      for (const t of entityList(scene.doc.trainTypes)) trainTypes.set(t.id, t);
      for (const f of entityList(scene.doc.formations)) formations.set(f.id, f);
    }
    return { trainTypes, formations };
  }, [generation]);

  const layoutRef = useRef<LineLayout | undefined>(undefined);
  layoutRef.current = layout;
  boundsRef.current = layout?.bounds ?? EMPTY_BOUNDS;

  const propsRef = useRef({ highlightDutyId, showDeadhead });
  propsRef.current = { highlightDutyId, showDeadhead };

  // A new document means the camera should frame the whole line again.
  useEffect(() => {
    fitted.current = false;
    layers.markAllDirty();
  }, [generation, layers]);

  // -- the frame --------------------------------------------------------------
  useEffect(() => {
    return registerFrameTask('line-view', 10, () => {
      const size = layers.sizeRef.current;
      viewportRef.current = { width: size.width, height: size.height };
      const currentLayout = layoutRef.current;
      if (!currentLayout || size.width === 0 || size.height === 0) return false;

      if (!fitted.current) {
        cameraRef.current = clampCamera(
          fitXToBounds(cameraRef.current, currentLayout.bounds, viewportRef.current, 40, LIMITS),
          currentLayout.bounds,
          viewportRef.current,
          24,
        );
        fitted.current = true;
        layers.markAllDirty();
      }

      const scene = getRenderScene();
      const theme = getTheme();
      const cam = cameraRef.current;
      const viewport = viewportRef.current;
      const env = { layout: currentLayout, camera: cam, theme, viewport };

      if (layers.consumeDirty('static')) {
        const ctx = layers.contextOf('static');
        if (ctx) drawLineStatic(ctx, env);
      }

      // The dynamic layer is skipped whenever nothing that affects it moved.
      const key = `${scene?.t ?? 0}|${cam.x}|${cam.y}|${cam.scaleX}|${cam.scaleY}|${propsRef.current.highlightDutyId ?? ''}|${propsRef.current.showDeadhead}`;
      const dynamicDirty = layers.consumeDirty('dynamic') || key !== lastDrawKey.current;
      if (dynamicDirty && scene) {
        lastDrawKey.current = key;
        const ctx = layers.contextOf('dynamic');
        hits.current.reset();
        if (ctx) {
          drawLineDynamic(ctx, {
            ...env,
            snapshot: scene.snapshot,
            trainTypes: lookups.trainTypes,
            formations: lookups.formations,
            hits: hits.current,
            showDeadhead: propsRef.current.showDeadhead,
            ...(propsRef.current.highlightDutyId !== undefined
              ? { highlightDutyId: propsRef.current.highlightDutyId }
              : {}),
          });
        }
        layers.markDirty('overlay');
      }

      if (layers.consumeDirty('overlay')) {
        const ctx = layers.contextOf('overlay');
        if (ctx) {
          const selected = selectedIds(scene?.selection?.selected);
          drawLineOverlay(ctx, {
            ...env,
            hits: hits.current,
            ...(hovered.current !== undefined ? { hovered: hovered.current } : {}),
            ...(selected !== undefined ? { selected } : {}),
          });
        }
      }

      return scene?.playing === true;
    });
  }, [layers, lookups]);

  // -- interaction ----------------------------------------------------------
  const onCameraChange = useCallback(() => {
    layers.markAllDirty();
  }, [layers]);

  const handleClick = useCallback(
    (x: number, y: number, additive: boolean) => {
      const trainId = hits.current.pick(x, y, 3);
      const ref: EntityRef | undefined =
        trainId !== undefined ? { kind: 'train', trainId } : undefined;
      onSelect?.(ref, additive);
    },
    [onSelect],
  );

  const handleHover = useCallback(
    (x: number, y: number) => {
      const next = hits.current.pick(x, y, 3);
      if (next === hovered.current) return;
      hovered.current = next;
      layers.markDirty('overlay');
    },
    [layers],
  );

  const handleLeave = useCallback(() => {
    if (hovered.current === undefined) return;
    hovered.current = undefined;
    layers.markDirty('overlay');
  }, [layers]);

  const handlers = usePanZoom(layers.containerRef, {
    cameraRef,
    boundsRef,
    viewportRef,
    limits: LIMITS,
    onCameraChange,
    onClick: handleClick,
    onHover: handleHover,
    onLeave: handleLeave,
  });

  // -- E2E digest -----------------------------------------------------------
  useEffect(() => {
    return registerDigest('line', (): RenderDigest => {
      const size = layers.sizeRef.current;
      const currentLayout = layoutRef.current;
      const scene = getRenderScene();
      if (!currentLayout || !scene) {
        return { view: 'line', width: size.width, height: size.height, trains: [], stations: [] };
      }
      return {
        view: 'line',
        width: size.width,
        height: size.height,
        trains: lineTrainPositions(currentLayout, cameraRef.current, scene.snapshot),
        stations: lineStationPositions(currentLayout, cameraRef.current),
      };
    });
  }, [layers]);

  return (
    <div
      data-testid={TID.lineView}
      className={className}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <div ref={layers.containerRef} style={layerStyles.container} {...handlers}>
        <canvas ref={layers.refs.static} style={layerStyles.canvas} aria-hidden="true" />
        <canvas
          ref={layers.refs.dynamic}
          data-testid={TID.lineViewCanvas}
          style={layerStyles.canvas}
          aria-hidden="true"
        />
        <canvas ref={layers.refs.overlay} style={layerStyles.canvas} aria-hidden="true" />
      </div>
      <LineViewShadow
        doc={shadowScene?.doc}
        snapshot={shadowScene?.snapshot}
        showDeadhead={showDeadhead}
      />
    </div>
  );
}

function selectedIds(refs: readonly EntityRef[] | undefined): ReadonlySet<string> | undefined {
  if (!refs || refs.length === 0) return undefined;
  const out = new Set<string>();
  for (const r of refs) if (r.kind === 'train') out.add(r.trainId);
  return out.size > 0 ? out : undefined;
}
