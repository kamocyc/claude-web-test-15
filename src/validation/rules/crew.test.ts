/**
 * 乗務員 rules. Each one gets the fixture that fires it and the fixture that
 * does not, and the "does not" case is always the untouched toy project —
 * which carries a small but complete crew plan for exactly this purpose.
 */

import { describe, expect, it } from 'vitest';
import type { CrewDuty, CrewLeg, ProjectDocument } from '@/domain/model';
import { TOY, toyProjectCopy } from '@/testing/toyProject';
import { expectIssue, idsFor, issuesFor } from '../testkit';

function crewDuty(doc: ProjectDocument, id: string): CrewDuty {
  const duty = doc.crewDuties.byId[id];
  if (duty === undefined) throw new Error('fixture changed');
  return duty;
}

function leg(doc: ProjectDocument, dutyId: string, index: number): CrewLeg {
  const found = crewDuty(doc, dutyId).legs[index];
  if (found === undefined) throw new Error('fixture changed');
  return found;
}

const H = 3600;
const M = 60;

describe('crew.continuityBreak', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProjectCopy(), 'crew.continuityBreak')).toEqual([]);
  });

  it('fires when the 待機 is at a different station from the train before it', () => {
    const doc = toyProjectCopy();
    const standby = leg(doc, TOY.crewDutyLocal, 2);
    if (standby.kind !== 'standby') throw new Error('fixture changed');
    standby.stationId = TOY.stationC;
    const issue = expectIssue(
      doc,
      'crew.continuityBreak',
      'crew.continuityBreak#cdt-1|2|place',
      'error',
    );
    expect(issue.detail).toContain('C駅');
  });

  it('fires when the next leg starts before the previous one ends', () => {
    const doc = toyProjectCopy();
    const standby = leg(doc, TOY.crewDutyLocal, 2);
    if (standby.kind !== 'standby') throw new Error('fixture changed');
    standby.from = 8 * H + 5 * M;
    expectIssue(doc, 'crew.continuityBreak', 'crew.continuityBreak#cdt-1|2|time', 'error');
  });
});

describe('crew.reliefPointInvalid', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProjectCopy(), 'crew.reliefPointInvalid')).toEqual([]);
  });

  it('fires when a crew leaves a train mid-run at a station with no relief', () => {
    const doc = toyProjectCopy();
    const work = leg(doc, TOY.crewDutyLocal, 1);
    if (work.kind !== 'train') throw new Error('fixture changed');
    work.toIndex = 2; // C駅, which has no 乗務員交代
    const issue = expectIssue(
      doc,
      'crew.reliefPointInvalid',
      'crew.reliefPointInvalid#cdt-1|1|alight',
      'error',
    );
    expect(issue.detail).toContain('C駅');
  });

  it('does not fire once that station is marked 交代可能', () => {
    const doc = toyProjectCopy();
    const work = leg(doc, TOY.crewDutyLocal, 1);
    if (work.kind !== 'train') throw new Error('fixture changed');
    work.toIndex = 2;
    doc.stations.byId[TOY.stationC]!.crewChange = true;
    expect(issuesFor(doc, 'crew.reliefPointInvalid')).toEqual([]);
  });
});

describe('crew.handoverTight', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProjectCopy(), 'crew.handoverTight')).toEqual([]);
  });

  it('fires when the change from 回送 to 各停 is under the minimum', () => {
    const doc = toyProjectCopy();
    doc.validationConfig.crewMinHandoverSec = 10 * M; // the fixture leaves 8 分
    const issue = expectIssue(doc, 'crew.handoverTight', 'crew.handoverTight#cdt-1|1', 'warning');
    expect(issue.detail).toContain('A駅');
  });
});

describe('crew.continuousWorkExceeded', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProjectCopy(), 'crew.continuousWorkExceeded')).toEqual([]);
  });

  it('fires when a stretch with no 休憩 runs past the limit', () => {
    const doc = toyProjectCopy();
    doc.validationConfig.crewMaxContinuousWorkSec = 25 * M; // both 行路 run 40 分
    expectIssue(
      doc,
      'crew.continuousWorkExceeded',
      'crew.continuousWorkExceeded#cdt-1|0',
      'warning',
    );
  });

  it('stops firing for the 行路 whose 待機 becomes a 休憩', () => {
    const doc = toyProjectCopy();
    doc.validationConfig.crewMaxContinuousWorkSec = 25 * M;
    doc.validationConfig.crewMinBreakSec = 5 * M;
    const duty = crewDuty(doc, TOY.crewDutyLocal);
    // The 待機 at D becomes a 休憩 taken at a base, and long enough to count:
    // the one 40-minute stretch becomes 20 分 and 10 分.
    duty.legs[2] = { kind: 'break', stationId: TOY.stationD, from: 8 * H + 10 * M + 30, to: 8 * H + 20 * M };
    doc.stations.byId[TOY.stationD]!.crewBase = true;
    const ids = idsFor(doc, 'crew.continuousWorkExceeded');
    expect(ids).not.toContain('crew.continuousWorkExceeded#cdt-1|0');
    // The express driver, who takes no break, still does.
    expect(ids).toContain('crew.continuousWorkExceeded#cdt-2|0');
  });
});

describe('crew.breakInsufficient', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProjectCopy(), 'crew.breakInsufficient')).toEqual([]);
  });

  it('fires when the 休憩 is too short and taken away from a base', () => {
    const doc = toyProjectCopy();
    const duty = crewDuty(doc, TOY.crewDutyLocal);
    duty.legs[2] = { kind: 'break', stationId: TOY.stationD, from: 8 * H + 10 * M + 30, to: 8 * H + 20 * M };
    expectIssue(doc, 'crew.breakInsufficient', 'crew.breakInsufficient#cdt-1|2|short', 'warning');
    const place = expectIssue(
      doc,
      'crew.breakInsufficient',
      'crew.breakInsufficient#cdt-1|2|place',
      'warning',
    );
    expect(place.detail).toContain('D駅');
  });

  it('fires on the total once the duty is long enough to need one', () => {
    const doc = toyProjectCopy();
    doc.validationConfig.crewMaxContinuousWorkSec = 0;
    expectIssue(doc, 'crew.breakInsufficient', 'crew.breakInsufficient#cdt-1|total', 'warning');
  });
});

describe('crew.workTimeExceeded', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProjectCopy(), 'crew.workTimeExceeded')).toEqual([]);
  });

  it('fires on 拘束時間 and on 実乗務時間 separately', () => {
    const doc = toyProjectCopy();
    doc.validationConfig.crewMaxSpreadSec = 10 * M;
    doc.validationConfig.crewMaxWorkSec = 5 * M;
    expectIssue(doc, 'crew.workTimeExceeded', 'crew.workTimeExceeded#cdt-1|spread', 'warning');
    expectIssue(doc, 'crew.workTimeExceeded', 'crew.workTimeExceeded#cdt-1|work', 'warning');
  });
});

describe('crew.doubleBooked', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProjectCopy(), 'crew.doubleBooked')).toEqual([]);
  });

  it('fires when one person is given both 行路', () => {
    const doc = toyProjectCopy();
    doc.crewAssignments.byId['cas-2']!.crewId = TOY.driver1;
    const issue = expectIssue(
      doc,
      'crew.doubleBooked',
      'crew.doubleBooked#crw-1|cdt-1|cdt-2',
      'error',
    );
    expect(issue.detail).toContain('11仕');
  });
});

describe('crew.roleMismatch', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProjectCopy(), 'crew.roleMismatch')).toEqual([]);
  });

  it('fires when a 車掌 is given a 運転士 の行路', () => {
    const doc = toyProjectCopy();
    doc.crew.byId[TOY.driver2]!.role = 'conductor';
    const issue = expectIssue(doc, 'crew.roleMismatch', 'crew.roleMismatch#cas-2|role', 'error');
    expect(issue.detail).toContain('車掌');
  });

  it('warns when the 所属 differs', () => {
    const doc = toyProjectCopy();
    doc.crew.byId[TOY.driver2]!.baseStationId = TOY.stationA;
    expectIssue(doc, 'crew.roleMismatch', 'crew.roleMismatch#cas-2|base', 'warning');
  });
});

describe('crew.trainNotCovered', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProjectCopy(), 'crew.trainNotCovered')).toEqual([]);
  });

  it('says nothing at all when there is no crew plan yet', () => {
    const doc = toyProjectCopy();
    doc.crewDuties = { byId: {}, allIds: [] };
    expect(issuesFor(doc, 'crew.trainNotCovered')).toEqual([]);
  });

  it('fires when a train has no 行路 covering it', () => {
    const doc = toyProjectCopy();
    const duty = crewDuty(doc, TOY.crewDutyExpress);
    duty.legs.splice(2, 1);
    const issue = expectIssue(
      doc,
      'crew.trainNotCovered',
      'crew.trainNotCovered#trn-2|driver',
      'warning',
    );
    expect(issue.detail).toContain('運転士');
  });

  it('fires when a train is covered only part of the way', () => {
    const doc = toyProjectCopy();
    const work = leg(doc, TOY.crewDutyLocal, 1);
    if (work.kind !== 'train') throw new Error('fixture changed');
    work.toIndex = 2;
    expectIssue(
      doc,
      'crew.trainNotCovered',
      'crew.trainNotCovered#trn-1|driver|partial',
      'warning',
    );
  });
});

describe('crew.notAtBase', () => {
  it('does not fire on the clean fixture', () => {
    expect(issuesFor(toyProjectCopy(), 'crew.notAtBase')).toEqual([]);
  });

  it('fires at both ends once the depot stops being a 乗務員基地', () => {
    const doc = toyProjectCopy();
    delete doc.stations.byId[TOY.stationDepot]!.crewBase;
    expectIssue(doc, 'crew.notAtBase', 'crew.notAtBase#cdt-1|start', 'warning');
    expectIssue(doc, 'crew.notAtBase', 'crew.notAtBase#cdt-1|end', 'warning');
    expectIssue(doc, 'crew.notAtBase', 'crew.notAtBase#cdt-1|station', 'warning');
  });
});
