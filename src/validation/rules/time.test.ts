import { describe, expect, it } from 'vitest';

import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { expectIssue, idsFor, issuesFor } from '../testkit';

const H = 3600;
const M = 60;

describe('time.nonMonotonic', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'time.nonMonotonic')).toEqual([]);
  });

  it('fires when the arrival is after the departure at one stop', () => {
    const doc = toyProjectCopy();
    const stop = doc.trains.byId[TOY.localDown]!.stops[1]!;
    stop.arr = 8 * H + 130;
    stop.dep = 8 * H + 120;
    const issue = expectIssue(
      doc,
      'time.nonMonotonic',
      'time.nonMonotonic#trn-1|1|arrAfterDep',
      'error',
    );
    expect(issue.detail).toContain('08:02:10');
  });

  it('fires when the origin carries an arrival time', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.stops[0]!.arr = 8 * H - 60;
    expect(idsFor(doc, 'time.nonMonotonic')).toContain('time.nonMonotonic#trn-1|0|originHasArr');
  });

  it('fires when the terminus carries a departure time', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.stops[3]!.dep = 8 * H + 11 * M;
    expect(idsFor(doc, 'time.nonMonotonic')).toContain('time.nonMonotonic#trn-1|3|terminusHasDep');
  });

  it('fires when the next station is not later', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.stops[1]!.dep = 8 * H + 5 * M;
    expect(idsFor(doc, 'time.nonMonotonic')).toContain('time.nonMonotonic#trn-1|1|notAdvancing');
  });
});

describe('time.runTooFast', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'time.runTooFast')).toEqual([]);
  });

  it('fires when a section beats base + start/stop penalties', () => {
    const doc = toyProjectCopy();
    // A→B minimum is 70 base + 10 stop penalty = 80 s; book it in 70.
    doc.trains.byId[TOY.localDown]!.stops[1]!.arr = 8 * H + 70;
    const issue = expectIssue(doc, 'time.runTooFast', 'time.runTooFast#trn-1|1', 'error');
    // 70s booked against a 90s minimum (base 70 + 10s start at the origin
    // stand + 10s stop at B).
    expect(issue.detail).toContain('20秒 不足');
  });

  it('charges the start penalty only after a real dwell', () => {
    const doc = toyProjectCopy();
    // B→C minimum is 70 + 10 (dwelt at B) + 10 (stops at C) = 90 s.
    doc.trains.byId[TOY.localDown]!.stops[2]!.arr = 8 * H + 120 + 89;
    expect(idsFor(doc, 'time.runTooFast')).toContain('time.runTooFast#trn-1|2');
    const ok = toyProjectCopy();
    ok.trains.byId[TOY.localDown]!.stops[2]!.arr = 8 * H + 120 + 90;
    expect(idsFor(ok, 'time.runTooFast')).not.toContain('time.runTooFast#trn-1|2');
  });
});

describe('time.runSlow', () => {
  it('does not flag a section that is only mildly padded', () => {
    expect(idsFor(toyProject(), 'time.runSlow')).not.toContain('time.runSlow#trn-1|2');
  });

  it('fires when a section takes more than 1.5x the minimum', () => {
    const doc = toyProjectCopy();
    // B→C minimum 90 s; book 240 s.
    doc.trains.byId[TOY.localDown]!.stops[2]!.arr = 8 * H + 120 + 240;
    const issue = expectIssue(doc, 'time.runSlow', 'time.runSlow#trn-1|2', 'info');
    expect(issue.detail).toContain('2.67 倍');
  });

  it('stays quiet for a train that is waiting to be overtaken there', () => {
    const doc = toyProjectCopy();
    // Slow C→D, but the local is held at C for the express, so the padding
    // belongs to the wait rather than to the run.
    doc.trains.byId[TOY.localDown]!.stops[3]!.arr = 8 * H + 8 * M + 300;
    expect(idsFor(doc, 'time.runSlow')).not.toContain('time.runSlow#trn-1|3');
    // Remove the overtake and the same padding is reported.
    const noOvertake = toyProjectCopy();
    noOvertake.trains.byId[TOY.localDown]!.stops[3]!.arr = 8 * H + 8 * M + 300;
    noOvertake.trains.byId[TOY.expressDown]!.stops[2]!.arr = 8 * H + 9 * M;
    noOvertake.trains.byId[TOY.expressDown]!.stops[2]!.dep = 8 * H + 9 * M;
    expect(idsFor(noOvertake, 'time.runSlow')).toContain('time.runSlow#trn-1|3');
  });
});

describe('time.dwellTooShort', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'time.dwellTooShort')).toEqual([]);
  });

  it('fires below the station minimum dwell', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.stops[1]!.dep = 8 * H + 100; // 10 s dwell
    const issue = expectIssue(
      doc,
      'time.dwellTooShort',
      'time.dwellTooShort#trn-1|1',
      'warning',
    );
    expect(issue.detail).toContain('20秒');
  });

  it('ignores 運転停車 and 回送', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.stops[1]!.dep = 8 * H + 100;
    doc.trains.byId[TOY.localDown]!.stops[1]!.operational = true;
    expect(issuesFor(doc, 'time.dwellTooShort')).toEqual([]);
    // 回8002 dwells 30 s at A, which is fine, but shortening it changes
    // nothing because the 回送 type is not a passenger service.
    const deadhead = toyProjectCopy();
    deadhead.trains.byId[TOY.depotIn]!.stops[3]!.dep = 8 * H + 26 * M + 5;
    expect(issuesFor(deadhead, 'time.dwellTooShort')).toEqual([]);
  });
});

describe('time.offGrain', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'time.offGrain')).toEqual([]);
  });

  it('fires on a time that is not a multiple of the grain', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.stops[1]!.arr = 8 * H + 91;
    const issue = expectIssue(doc, 'time.offGrain', 'time.offGrain#trn-1|1|arr', 'info');
    expect(issue.detail).toContain('5秒');
  });
});

describe('time.outsideServiceDay', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'time.outsideServiceDay')).toEqual([]);
  });

  it('fires before the service day starts', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.stops[0]!.dep = 1 * H;
    expect(
      expectIssue(
        doc,
        'time.outsideServiceDay',
        'time.outsideServiceDay#trn-1|0|dep',
        'warning',
      ).at,
    ).toBe(1 * H);
  });

  it('fires after the service day ends', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.stops[3]!.arr = 31 * H;
    expect(idsFor(doc, 'time.outsideServiceDay')).toContain(
      'time.outsideServiceDay#trn-1|3|arr',
    );
  });
});
