import { describe, expect, it } from 'vitest';

import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { expectIssue, idsFor, issuesFor } from '../testkit';

const H = 3600;
const M = 60;

describe('headway.section', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'headway.section')).toEqual([]);
  });

  it('fires when two trains enter the same section too close together', () => {
    const doc = toyProjectCopy();
    // The express leaves A one minute behind the local; the minimum is two.
    doc.trains.byId[TOY.expressDown]!.stops[0]!.dep = 8 * H + 1 * M;
    const issue = expectIssue(
      doc,
      'headway.section',
      'headway.section#lnk-1|down|enter|trn-1|trn-2',
      'error',
    );
    expect(issue.detail).toContain('1分');
    expect(issue.detail).toContain('2分');
  });

  it('catches an express closing on a local by the far end of a section', () => {
    const doc = toyProjectCopy();
    // Entries stay 2 min apart on B→C, but the express arrives at C only
    // 30 s after the local does.
    doc.trains.byId[TOY.expressDown]!.stops[1]!.arr = 8 * H + 4 * M + 40;
    doc.trains.byId[TOY.expressDown]!.stops[1]!.dep = 8 * H + 4 * M + 40;
    doc.trains.byId[TOY.expressDown]!.stops[2]!.arr = 8 * H + 4 * M + 30;
    doc.trains.byId[TOY.expressDown]!.stops[2]!.dep = 8 * H + 4 * M + 30;
    const ids = idsFor(doc, 'headway.section');
    expect(ids).toContain('headway.section#lnk-2|down|exit|trn-1|trn-2');
  });

  it('does not couple trains running in opposite directions', () => {
    const doc = toyProjectCopy();
    // 回8002 passes C going up at the same moment the local arrives going down.
    doc.trains.byId[TOY.depotIn]!.stops[0]!.dep = 8 * H + 2 * M;
    doc.trains.byId[TOY.depotIn]!.stops[1]!.arr = 8 * H + 4 * M;
    doc.trains.byId[TOY.depotIn]!.stops[1]!.dep = 8 * H + 4 * M + 30;
    const ids = idsFor(doc, 'headway.section');
    expect(ids.filter((id) => id.includes(TOY.depotIn) && id.includes(TOY.localDown))).toEqual([]);
  });
});

describe('headway.overtakeMidSection', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'headway.overtakeMidSection')).toEqual([]);
  });

  it('fires when a train entering later leaves the section earlier', () => {
    const doc = toyProjectCopy();
    // Let the local out of C before the express reaches it, but keep the
    // local's arrival at D behind the express: the pass now happens C→D.
    doc.trains.byId[TOY.localDown]!.stops[2]!.dep = 8 * H + 5 * M;
    const issue = expectIssue(
      doc,
      'headway.overtakeMidSection',
      'headway.overtakeMidSection#lnk-3|down|trn-1|trn-2',
      'error',
    );
    expect(issue.detail).toContain('駅間');
  });
});
