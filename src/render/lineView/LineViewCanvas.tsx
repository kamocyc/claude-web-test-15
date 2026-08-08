/** STUB — owned by the render stream. Replace the body, keep the props type. */
import { TID } from '@e2e/testids';
import type { LineViewProps } from '../types';

export function LineViewCanvas(_props: LineViewProps) {
  return (
    <div data-testid={TID.lineView}>
      <canvas data-testid={TID.lineViewCanvas} />
      <ul className="visually-hidden" data-testid={TID.lineViewTrains} />
    </div>
  );
}
