/**
 * 運行図表 — the string diagram.
 *
 * The layering decision pays off most here. All ~500 train polylines live on
 * the STATIC canvas: their geometry depends on the timetable and the camera,
 * not on the clock, so a playing clock redraws only a vertical line and a
 * handful of dots. Redrawing 10 000 line segments 60 times a second to produce
 * a pixel-identical image would be the single biggest waste in the app.
 *
 * Dragging the now-line calls `onSeek`. That gesture is claimed through
 * `usePanZoom`'s `interceptDown` hook so it composes with pan/zoom instead of
 * fighting it.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { TID } from '@e2e/testids';
import type { TrainId } from '@/domain/ids';
import type { Sec } from '@/domain/units';
import type { EntityRef } from '@/validation/types';
import {
  clampCamera,
  createCamera,
  fitToBounds,
  screenToWorldX,
  worldToScreenX,
  type Camera2D,
  type ScaleLimits,
  type Viewport,
  type WorldBounds,
} from '../canvas/camera';
import { pickSegment } from '../canvas/hit';
import { registerFrameTask } from '../canvas/rafLoop';
import { getTheme } from '../canvas/theme';
import { layerStyles, useCanvasLayers } from '../canvas/useCanvasLayers';
import { usePanZoom, type CustomDrag } from '../canvas/usePanZoom';
import { getRenderScene, useSceneGeneration } from '../scene';
import { registerDigest } from '../testHooks';
import type { RenderDigest, StringDiagramProps } from '../types';
import {
  diagramStationPositions,
  diagramTrainPositions,
  drawDiagramDynamic,
  drawDiagramOverlay,
  drawDiagramStatic,
} from './draw';
import { computeDiagramLayout, type DiagramLayout } from './layout';
import { StringDiagramShadow } from './StringDiagramShadow';

const LIMITS: ScaleLimits = {
  // 0.002 px/s shows a whole 27-hour service day; 1.2 px/s is ~1 px per second.
  minScaleX: 0.002,
  maxScaleX: 1.2,
  minScaleY: 2,
  maxScaleY: 400,
};

const EMPTY_BOUNDS: WorldBounds = { minX: 0, maxX: 3600, minY: 0, maxY: 1 };
/** How close to the now-line a pointer must be to grab it. */
const SEEK_GRAB_PX = 7;

export function StringDiagramCanvas(props: StringDiagramProps) {
  const {
    onSelect,
    onSeek,
    highlightDutyId,
    showDeadhead = true,
    verticalScale = 'km',
    direction = 'both',
    selectedTrainIds,
    className,
  } = props;

  const layers = useCanvasLayers();
  // The diagram's shadow is derived from the LAYOUT, not the snapshot, so it
  // does not need the 4 Hz scene at all — a clock tick re-renders nothing here.
  const generation = useSceneGeneration();

  const cameraRef = useRef<Camera2D>(createCamera());
  const boundsRef = useRef<WorldBounds>(EMPTY_BOUNDS);
  const viewportRef = useRef<Viewport>({ width: 0, height: 0 });
  const hovered = useRef<TrainId | undefined>(undefined);
  const fitted = useRef(false);
  const staticKey = useRef('');
  const dynamicKey = useRef('');

  const layout: DiagramLayout | undefined = useMemo(() => {
    const scene = getRenderScene();
    if (!scene) return undefined;
    return computeDiagramLayout(scene.index, { verticalScale, showDeadhead, direction });
  }, [generation, verticalScale, showDeadhead, direction]);

  const layoutRef = useRef<DiagramLayout | undefined>(undefined);
  layoutRef.current = layout;
  boundsRef.current = layout?.bounds ?? EMPTY_BOUNDS;

  // A string key, not the array, so a caller that rebuilds the array on every
  // render does not force a redraw of 500 polylines.
  const selectedKey = (selectedTrainIds ?? []).join(',');
  const selected = useMemo(
    () => new Set<string>(selectedKey === '' ? [] : selectedKey.split(',')),
    [selectedKey],
  );

  const propsRef = useRef({ highlightDutyId, onSeek, selected });
  propsRef.current = { highlightDutyId, onSeek, selected };

  // Only a change that invalidates the layout re-fits the camera. Depending on
  // `layers` here re-ran this on every render, which meant the view snapped
  // back to the fitted zoom about four times a second while the clock played.
  const { markAllDirty } = layers;
  useEffect(() => {
    fitted.current = false;
    staticKey.current = '';
    markAllDirty();
  }, [generation, verticalScale, showDeadhead, direction, highlightDutyId, markAllDirty]);

  // -- the frame ------------------------------------------------------------
  useEffect(() => {
    return registerFrameTask('string-diagram', 10, () => {
      const size = layers.sizeRef.current;
      viewportRef.current = { width: size.width, height: size.height };
      const currentLayout = layoutRef.current;
      if (!currentLayout || size.width === 0 || size.height === 0) return false;

      if (!fitted.current) {
        cameraRef.current = clampCamera(
          fitToBounds(currentLayout.bounds, viewportRef.current, 48, LIMITS),
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
      const highlight = propsRef.current.highlightDutyId;
      const selectedSet = propsRef.current.selected;
      const env = {
        layout: currentLayout,
        camera: cam,
        theme,
        viewport,
        selected: selectedSet,
        ...(highlight !== undefined ? { highlightDutyId: highlight } : {}),
      };

      // The static layer — every polyline — is rebuilt only when the camera
      // or the layout changes. Never on a clock tick.
      const sKey = `${cam.x}|${cam.y}|${cam.scaleX}|${cam.scaleY}|${highlight ?? ''}|${[...selectedSet].join(',')}`;
      if (layers.consumeDirty('static') || sKey !== staticKey.current) {
        staticKey.current = sKey;
        const ctx = layers.contextOf('static');
        if (ctx) drawDiagramStatic(ctx, env);
        layers.markDirty('dynamic');
        layers.markDirty('overlay');
      }

      const dKey = `${sKey}|${scene?.t ?? 0}`;
      if ((layers.consumeDirty('dynamic') || dKey !== dynamicKey.current) && scene) {
        dynamicKey.current = dKey;
        const ctx = layers.contextOf('dynamic');
        if (ctx) {
          drawDiagramDynamic(ctx, {
            ...env,
            t: scene.t,
            snapshot: scene.snapshot,
          });
        }
      }

      if (layers.consumeDirty('overlay')) {
        const ctx = layers.contextOf('overlay');
        if (ctx) {
          drawDiagramOverlay(ctx, {
            ...env,
            ...(hovered.current !== undefined ? { hovered: hovered.current } : {}),
          });
        }
      }

      return scene?.playing === true;
    });
  }, [layers]);

  // -- interaction ----------------------------------------------------------
  const onCameraChange = useCallback(() => {
    layers.markAllDirty();
  }, [layers]);

  const handleHover = useCallback(
    (x: number, y: number) => {
      const currentLayout = layoutRef.current;
      if (!currentLayout) return;
      const hit = pickSegment(currentLayout.segments, cameraRef.current, x, y, 6);
      const next = hit?.segment.ref;
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

  const handleClick = useCallback(
    (x: number, y: number, additive: boolean) => {
      const currentLayout = layoutRef.current;
      if (!currentLayout) return;
      const hit = pickSegment(currentLayout.segments, cameraRef.current, x, y, 6);
      const ref: EntityRef | undefined = hit
        ? { kind: 'train', trainId: hit.segment.ref }
        : undefined;
      onSelect?.(ref, additive);
    },
    [onSelect],
  );

  /** Grab the now-line if the pointer came down on it. */
  const interceptDown = useCallback((x: number, y: number): CustomDrag | undefined => {
    const seek = propsRef.current.onSeek;
    if (!seek) return undefined;
    const scene = getRenderScene();
    if (!scene) return undefined;
    const nowX = worldToScreenX(cameraRef.current, scene.t);
    // The handle at the top of the line is a generous target; the line itself
    // is grabbable anywhere along its length.
    const onHandle = y <= 16 && Math.abs(x - nowX) <= 24;
    if (!onHandle && Math.abs(x - nowX) > SEEK_GRAB_PX) return undefined;
    return (px: number) => {
      const t: Sec = Math.round(screenToWorldX(cameraRef.current, px));
      seek(t);
    };
  }, []);

  const handlers = usePanZoom(layers.containerRef, {
    cameraRef,
    boundsRef,
    viewportRef,
    limits: LIMITS,
    onCameraChange,
    onClick: handleClick,
    onHover: handleHover,
    onLeave: handleLeave,
    interceptDown,
  });

  // -- E2E digest -----------------------------------------------------------
  useEffect(() => {
    return registerDigest('diagram', (): RenderDigest => {
      const size = layers.sizeRef.current;
      const currentLayout = layoutRef.current;
      const scene = getRenderScene();
      if (!currentLayout || !scene) {
        return {
          view: 'diagram',
          width: size.width,
          height: size.height,
          trains: [],
          stations: [],
        };
      }
      return {
        view: 'diagram',
        width: size.width,
        height: size.height,
        trains: diagramTrainPositions(currentLayout, cameraRef.current, scene.snapshot, scene.t),
        stations: diagramStationPositions(currentLayout, cameraRef.current),
      };
    });
  }, [layers]);

  return (
    <div
      data-testid={TID.diagram}
      className={className}
      // Position and size are the host's decision, not ours. Editor.module.css
      // .canvasHost pins this element with `position:absolute; inset:0`, which
      // is what gives the `height: 100%` chain below a definite box to resolve
      // against. Setting either here would win over the stylesheet and
      // collapse the layers to zero height.
    >
      <div ref={layers.containerRef} style={layerStyles.container} {...handlers}>
        <canvas
          ref={layers.refs.static}
          data-testid={TID.diagramCanvas}
          style={layerStyles.canvas}
          aria-hidden="true"
        />
        <canvas ref={layers.refs.dynamic} style={layerStyles.canvas} aria-hidden="true" />
        <canvas ref={layers.refs.overlay} style={layerStyles.canvas} aria-hidden="true" />
      </div>
      <StringDiagramShadow layout={layout} />
    </div>
  );
}
