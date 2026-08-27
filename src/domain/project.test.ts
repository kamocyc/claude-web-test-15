import { describe, expect, it } from 'vitest';

import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { isSingleTrackLine } from './project';

describe('isSingleTrackLine', () => {
  it('is false for the double-track fixture', () => {
    expect(isSingleTrackLine(toyProject())).toBe(false);
  });

  it('is true when every running section is single track', () => {
    const doc = toyProjectCopy();
    for (const id of [TOY.linkAB, TOY.linkBC, TOY.linkCD]) {
      doc.links.byId[id]!.trackCount = 1;
    }
    expect(isSingleTrackLine(doc)).toBe(true);
  });

  it('ignores the depot access link', () => {
    // A yard stub is single track almost by definition — it is the way in, not
    // a section of the railway. Counting it would make every line with a yard
    // look 単線, and leaving the running sections double must still say false.
    const doc = toyProjectCopy();
    doc.links.byId[TOY.linkDepot]!.trackCount = 1;
    expect(isSingleTrackLine(doc)).toBe(false);

    for (const id of [TOY.linkAB, TOY.linkBC, TOY.linkCD]) {
      doc.links.byId[id]!.trackCount = 1;
    }
    doc.links.byId[TOY.linkDepot]!.trackCount = 2;
    expect(isSingleTrackLine(doc)).toBe(true);
  });

  it('is false for a line with no running sections at all', () => {
    const doc = toyProjectCopy();
    doc.links = { byId: {}, allIds: [] };
    expect(isSingleTrackLine(doc)).toBe(false);
  });
});
