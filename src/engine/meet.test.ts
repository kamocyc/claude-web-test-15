import { describe, expect, it } from 'vitest';

import type { ProjectDocument } from '@/domain/model';
import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { buildIndex } from './buildIndex';

const H = 3600;
const M = 60;

/** The toy line with every running section made single track. */
function singleTrackToy(): ProjectDocument {
  const doc = toyProjectCopy();
  for (const id of [TOY.linkAB, TOY.linkBC, TOY.linkCD]) {
    doc.links.byId[id]!.trackCount = 1;
  }
  return doc;
}

/**
 * Bring the 入庫 up train forward so it stands at C while the local is there.
 *
 * C is the only station on the toy line with more than two roads, which is
 * exactly why the fixture put the passing loop there — and a passing loop is
 * what a 交換 needs too. The up train takes c3, the local is already on c2, so
 * this is a legal meet and `track.doubleOccupancy` has nothing to say about it.
 */
function meetAtC(doc: ProjectDocument): ProjectDocument {
  const up = doc.trains.byId[TOY.depotIn]!;
  up.stops[0]!.dep = 8 * H + 4 * M; // D
  up.stops[1]!.arr = 8 * H + 6 * M; // C
  up.stops[1]!.dep = 8 * H + 7 * M;
  up.stops[1]!.kind = 'stop';
  up.stops[2]!.arr = 8 * H + 9 * M; // B
  up.stops[2]!.dep = 8 * H + 9 * M + 30;
  up.stops[3]!.arr = 8 * H + 11 * M; // A
  up.stops[3]!.dep = 8 * H + 13 * M;
  up.stops[4]!.arr = 8 * H + 15 * M; // depot
  return doc;
}

describe('detectMeets', () => {
  it('finds nothing on a double-track line', () => {
    // The same trains, the same times — only the track count differs. A meet
    // is defined by the constraint that forces it, and on double track there
    // is no constraint, so two trains at one station are just two trains.
    expect(buildIndex(meetAtC(toyProjectCopy())).meets).toHaveLength(0);
  });

  it('finds nothing when the single-track line has no simultaneous pair', () => {
    expect(buildIndex(singleTrackToy()).meets).toHaveLength(0);
  });

  it('finds a meet for every opposing pair standing at C at once', () => {
    // Three trains are at C together: the local waiting out its 待避, the
    // express calling on the through road, and the up train. One up train
    // therefore meets *two* down trains — the pairing is per pair, not per
    // station, because it is the pair that has to get past each other.
    const idx = buildIndex(meetAtC(singleTrackToy()));
    expect(idx.meets).toEqual([
      {
        stationId: TOY.stationC,
        downTrainId: TOY.localDown,
        upTrainId: TOY.depotIn,
        at: 8 * H + 6 * M,
        overlapSec: 60,
      },
      {
        stationId: TOY.stationC,
        downTrainId: TOY.expressDown,
        upTrainId: TOY.depotIn,
        at: 8 * H + 6 * M,
        overlapSec: 30,
      },
    ]);
  });

  it('marks both trains as held — neither one is "the" one waiting', () => {
    const idx = buildIndex(meetAtC(singleTrackToy()));
    const heldAtC = (trainId: typeof TOY.localDown): boolean =>
      idx.timelines.get(trainId)!.events.find((e) => e.stationId === TOY.stationC)!.isMeetWait;
    expect(heldAtC(TOY.localDown)).toBe(true);
    expect(heldAtC(TOY.depotIn)).toBe(true);
    // ...and only where the meet is.
    expect(idx.timelines.get(TOY.localDown)!.events.filter((e) => e.isMeetWait)).toHaveLength(1);
    expect(idx.timelines.get(TOY.depotIn)!.events.filter((e) => e.isMeetWait)).toHaveLength(1);
  });

  it('does not pair two trains running the same way', () => {
    // The express calls at C 08:06:00–08:06:30 while the local stands there —
    // that is a 待避, and `detectOvertakes` already owns it.
    const idx = buildIndex(singleTrackToy());
    expect(idx.overtakes).toHaveLength(1);
    expect(idx.meets).toHaveLength(0);
  });

  it('ignores stations that only touch double track', () => {
    // Single track between A and B alone: A and B can host a meet, C and D
    // cannot, and the meet in this fixture is at C.
    const doc = meetAtC(toyProjectCopy());
    doc.links.byId[TOY.linkAB]!.trackCount = 1;
    expect(buildIndex(doc).meets).toHaveLength(0);
  });

  it('is unaffected by the bundled double-track sample', () => {
    expect(buildIndex(toyProject()).meets).toEqual([]);
  });
});
