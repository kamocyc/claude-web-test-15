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

describe('headway.singleTrackOpposing', () => {
  it('does not fire on the clean fixture', () => {
    // Every section of the toy line is double track, so the rule has nothing
    // to look at however the trains are timed.
    expect(issuesFor(toyProject(), 'headway.singleTrackOpposing')).toEqual([]);
  });

  it('does not fire when a single-track section is used by one train at a time', () => {
    const doc = toyProjectCopy();
    doc.links.byId[TOY.linkCD]!.trackCount = 1;
    // C→D down is 08:08:30–08:10:30 and 08:06:30–08:08:00; D→C up is
    // 08:20–08:22. The section is single, and it is never shared.
    expect(issuesFor(doc, 'headway.singleTrackOpposing')).toEqual([]);
  });

  it('fires when an up train and a down train share a single-track section', () => {
    const doc = toyProjectCopy();
    doc.links.byId[TOY.linkCD]!.trackCount = 1;
    // Bring the 入庫 forward into the local's C→D run: down 08:08:30–08:10:30
    // against up 08:09:00–08:11:00 is 90 seconds of the same rails.
    const up = doc.trains.byId[TOY.depotIn]!;
    up.stops[0]!.dep = 8 * H + 9 * M;
    up.stops[1]!.arr = 8 * H + 11 * M;
    up.stops[1]!.dep = 8 * H + 11 * M + 30;

    const issue = expectIssue(
      doc,
      'headway.singleTrackOpposing',
      'headway.singleTrackOpposing#lnk-3|trn-1|trn-4',
      'error',
    );
    expect(issue.detail).toContain('単線');
    expect(issue.detail).toContain('1分30秒');
    expect(issue.refs).toContainEqual({ kind: 'link', linkId: TOY.linkCD });
  });

  it('does not fire on trains that merely touch at the section boundary', () => {
    // The down train is clear of the section at the instant the up train is
    // given it. That is ordinary working on a single line, not a near miss.
    const doc = toyProjectCopy();
    doc.links.byId[TOY.linkCD]!.trackCount = 1;
    const up = doc.trains.byId[TOY.depotIn]!;
    up.stops[0]!.dep = 8 * H + 10 * M + 30;
    up.stops[1]!.arr = 8 * H + 12 * M + 30;
    up.stops[1]!.dep = 8 * H + 13 * M;
    expect(issuesFor(doc, 'headway.singleTrackOpposing')).toEqual([]);
  });

  it('leaves following moves to headway.section', () => {
    // Two down trains nose to tail on a single-track section is a spacing
    // question, and this rule is only about opposition.
    const doc = toyProjectCopy();
    doc.links.byId[TOY.linkAB]!.trackCount = 1;
    doc.trains.byId[TOY.expressDown]!.stops[0]!.dep = 8 * H + 1 * M;
    expect(issuesFor(doc, 'headway.singleTrackOpposing')).toEqual([]);
    expect(idsFor(doc, 'headway.section')).toContain(
      'headway.section#lnk-1|down|enter|trn-1|trn-2',
    );
  });
});
