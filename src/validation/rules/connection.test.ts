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
    // 回8001 never reaches C.
    doc.trains.byId[TOY.localDown]!.stops[2]!.connectsTo = [TOY.depotOut];
    const issue = expectIssue(
      doc,
      'connection.declaredFails',
      'connection.declaredFails#trn-1|2|trn-3|absent',
      'error',
    );
    expect(issue.detail).toContain('居合わせ');
  });

  it('fires when the declared partner runs through without stopping', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.expressDown]!.stops[2]!.kind = 'pass';
    doc.trains.byId[TOY.localDown]!.stops[2]!.connectsTo = [TOY.expressDown];
    const issue = expectIssue(
      doc,
      'connection.declaredFails',
      'connection.declaredFails#trn-1|2|trn-2|blocked',
      'error',
    );
    expect(issue.detail).toContain('通過');
  });

  it('fires when the declared partner is no faster from here', () => {
    const doc = toyProjectCopy();
    // Two locals: same stopping pattern, so there is nothing to change to.
    doc.trains.byId[TOY.expressDown]!.typeId = TOY.typeLocal;
    doc.trains.byId[TOY.expressDown]!.stops[1]!.kind = 'stop';
    doc.trains.byId[TOY.localDown]!.stops[2]!.connectsTo = [TOY.expressDown];
    const issue = expectIssue(
      doc,
      'connection.declaredFails',
      'connection.declaredFails#trn-1|2|trn-2|blocked',
      'error',
    );
    expect(issue.detail).toContain('緩急接続');
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
  it('reports one collapsed row per station, not one per pair', () => {
    const issue = expectIssue(
      toyProject(),
      'connection.discovered',
      'connection.discovered#stn-3',
      'info',
    );
    expect(idsFor(toyProject(), 'connection.discovered')).toHaveLength(1);
    expect(issue.detail).toContain('1 件');
    expect(issue.detail).toContain('未申告 1');
  });

  it('reports nothing where there is no connection point', () => {
    const doc = toyProjectCopy();
    doc.stations.byId[TOY.stationC]!.isConnectionPoint = false;
    expect(issuesFor(doc, 'connection.discovered')).toEqual([]);
  });

  it('counts the declaration once the connection is declared', () => {
    const doc = toyProjectCopy();
    doc.trains.byId[TOY.localDown]!.stops[2]!.connectsTo = [TOY.expressDown];
    const issue = expectIssue(
      doc,
      'connection.discovered',
      'connection.discovered#stn-3',
      'info',
    );
    expect(issue.detail).toContain('申告済 1');
    expect(issue.detail).toContain('未申告 0');
  });

  it('says nothing about a transfer outside the window', () => {
    expect(idsFor(expressThroughCAfter(30), 'connection.discovered')).toEqual([]);
  });
});
