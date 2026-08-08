/** STUB — owned by the render stream. Replace the body, keep the props type. */
import { TID } from '@e2e/testids';
import type { StringDiagramProps } from '../types';

export function StringDiagramCanvas(_props: StringDiagramProps) {
  return (
    <div data-testid={TID.diagram}>
      <canvas data-testid={TID.diagramCanvas} />
      <ul className="visually-hidden" data-testid={TID.diagramTrains} />
    </div>
  );
}
