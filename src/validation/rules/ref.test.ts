import { describe, expect, it } from 'vitest';

import { asId } from '@/domain/ids';
import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { expectIssue, idsFor, issuesFor } from '../testkit';

describe('ref.dangling', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'ref.dangling')).toEqual([]);
  });

  it('reports a train pointing at a missing train type', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.typeId = asId<'TrainType'>('typ-999');
    const issue = expectIssue(
      doc,
      'ref.dangling',
      'ref.dangling#trains.trn-1.typeId|typ-999',
      'error',
    );
    expect(issue.detail).toContain('typ-999');
    expect(issue.refs[0]).toEqual({ kind: 'train', trainId: TOY.localDown });
  });

  it('reports a stop pointing at a missing station track', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.stops[1]!.trackId = asId<'StationTrack'>('trk-999');
    expect(idsFor(doc, 'ref.dangling')).toContain(
      'ref.dangling#trains.trn-1.stops[1].trackId|trk-999',
    );
  });

  it('reports a duty leg pointing at a missing train', () => {
    const doc = toyProjectCopy();
    doc.duties.byId[TOY.dutyExpress]!.legs = [
      { kind: 'train', trainId: asId<'Train'>('trn-999') },
    ];
    expect(idsFor(doc, 'ref.dangling')).toContain(
      'ref.dangling#duties.dut-2.legs[0].trainId|trn-999',
    );
  });
});
