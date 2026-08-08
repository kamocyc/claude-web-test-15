import { describe, expect, it } from 'vitest';

import { TOY, toyProject, toyProjectCopy } from '@/testing/toyProject';
import { expectIssue, idsFor, issuesFor } from '../testkit';

const H = 3600;
const M = 60;

/** Move the express through C `sec` after the local arrives at 08:04. */
function expressThroughCAfter(sec: number): ReturnType<typeof toyProjectCopy> {
  const doc = toyProjectCopy();
  const express = doc.trains.byId[TOY.expressDown]!;
  express.stops[2]!.arr = 8 * H + 4 * M + sec;
  express.stops[2]!.dep = 8 * H + 4 * M + sec;
  return doc;
}

describe('connection.declaredFails', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProject(), 'connection.declaredFails')).toEqual([]);
  });

  it('fires when the declared partner is not there at all', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.stops[2]!.connectsTo = [TOY.depotIn];
    const issue = expectIssue(
      doc,
      'connection.declaredFails',
      'connection.declaredFails#trn-1|2|trn-4|absent',
      'error',
    );
    expect(issue.detail).toContain('居合わせ');
  });

  it('fires when the transfer margin is below the minimum', () => {
    const doc = expressThroughCAfter(30); // minimum is 60 s
    doc.trains.byId[TOY.localDown]!.stops[2]!.connectsTo = [TOY.expressDown];
    const issue = expectIssue(
      doc,
      'connection.declaredFails',
      'connection.declaredFails#trn-1|2|trn-2|window',
      'error',
    );
    expect(issue.detail).toContain('30秒');
  });

  it('accepts a declaration that sits inside the window', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.stops[2]!.connectsTo = [TOY.expressDown];
    expect(issuesFor(doc, 'connection.declaredFails')).toEqual([]);
  });
});

describe('connection.qualityGap', () => {
  it('does not fire on the clean fixture — the 待避 buys a real connection', () => {
    expect(issuesFor(toyProject(), 'connection.qualityGap')).toEqual([]);
  });

  it('fires when the local waits but the express is not catchable', () => {
    const doc = expressThroughCAfter(30);
    const issue = expectIssue(
      doc,
      'connection.qualityGap',
      'connection.qualityGap#stn-3|trn-1|trn-2',
      'warning',
    );
    expect(issue.detail).toContain('C駅');
    expect(issue.detail).toContain('待避');
  });

  it('fires when the waiting station is not really a connection point', () => {
    const doc = toyProjectCopy();
    doc.stations.byId[TOY.stationC]!.isConnectionPoint = false;
    // No connection point means no transfer is expected: stay quiet.
    expect(issuesFor(doc, 'connection.qualityGap')).toEqual([]);
  });
});

describe('connection.discovered', () => {
  it('reports the 緩急接続 the fixture is built around', () => {
    const issue = expectIssue(
      toyProject(),
      'connection.discovered',
      'connection.discovered#stn-3|trn-1|trn-2',
      'info',
    );
    expect(issue.detail).toContain('2分');
    expect(issue.detail).toContain('未申告');
  });

  it('reports nothing where there is no connection point', () => {
    const doc = toyProjectCopy();
    doc.stations.byId[TOY.stationC]!.isConnectionPoint = false;
    expect(issuesFor(doc, 'connection.discovered')).toEqual([]);
  });

  it('drops the 未申告 note once the connection is declared', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.stops[2]!.connectsTo = [TOY.expressDown];
    const issue = expectIssue(
      doc,
      'connection.discovered',
      'connection.discovered#stn-3|trn-1|trn-2',
      'info',
    );
    expect(issue.detail).not.toContain('未申告');
  });

  it('says nothing about a transfer outside the window', () => {
    expect(idsFor(expressThroughCAfter(30), 'connection.discovered')).toEqual([]);
  });
});
