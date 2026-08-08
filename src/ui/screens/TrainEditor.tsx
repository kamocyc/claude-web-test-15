/**
 * 列車 — the attributes of a whole train column, and its deletion.
 *
 * The grid column is 62 px wide, which is enough for a 列車番号 and nothing
 * else, so everything that is a property of the *train* rather than of one stop
 * is edited here instead. Deletion is a separate, confirmed step: `train/remove`
 * also strips the train out of every duty and out of every other train's
 * 待避/接続 list, so the dialog lists what it is about to touch.
 */

import { TID } from '@e2e/testids';

import type { DayTypeId, TrainTypeId } from '@/domain/ids';
import type { Direction, ProjectDocument, Train, TrainCategory } from '@/domain/model';
import { findDependants } from '@/domain/integrity';
import { trainLabel } from '@/domain/project';
import { entityList } from '@/domain/units';
import { Card, Field } from '../components/Field';
import { useDispatch } from '../hooks';
import { clearing, numberOrUndefined } from '../patch';

import styles from './Editor.module.css';
import grid from './Timetable.module.css';

const CATEGORY_LABEL: Record<TrainCategory, string> = {
  service: '営業',
  deadhead: '回送',
  test: '試運転',
  shunt: '入換',
};

const CATEGORIES: TrainCategory[] = ['service', 'deadhead', 'test', 'shunt'];

export function TrainEditor({
  doc,
  train,
  onRequestDelete,
}: {
  doc: ProjectDocument;
  train: Train | undefined;
  onRequestDelete(): void;
}) {
  const dispatch = useDispatch();

  if (train === undefined) {
    return (
      <Card title="列車">
        <p className={styles.empty}>列車を選択してください</p>
      </Card>
    );
  }

  const types = entityList(doc.trainTypes);
  const dayTypes = entityList(doc.dayTypes);

  return (
    <Card
      title="列車"
      actions={
        <button type="button" className={styles.danger} onClick={onRequestDelete}>
          この列車を削除
        </button>
      }
    >
      <div className={styles.form} data-testid={TID.trainEditor}>
        <Field label="列車番号">
          <input
            className={styles.narrow}
            data-testid={TID.trainEditNumber}
            value={train.number}
            onChange={(e) =>
              dispatch({
                type: 'train/update',
                id: train.id,
                patch: { number: e.currentTarget.value },
              })
            }
          />
        </Field>
        <Field label="種別">
          <select
            data-testid={TID.trainEditType}
            value={train.typeId}
            onChange={(e) =>
              dispatch({
                type: 'train/update',
                id: train.id,
                patch: { typeId: e.currentTarget.value as TrainTypeId },
              })
            }
          >
            {types.length === 0 ? <option value="">(種別なし)</option> : null}
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="方向">
          <select
            data-testid={TID.trainEditDirection}
            value={train.direction}
            onChange={(e) =>
              dispatch({
                type: 'train/update',
                id: train.id,
                patch: { direction: e.currentTarget.value as Direction },
              })
            }
          >
            <option value="down">下り ({doc.line.downDirectionLabel})</option>
            <option value="up">上り ({doc.line.upDirectionLabel})</option>
          </select>
        </Field>
        <Field label="区分">
          <select
            data-testid={TID.trainEditCategory}
            value={train.category}
            onChange={(e) =>
              dispatch({
                type: 'train/update',
                id: train.id,
                patch: { category: e.currentTarget.value as TrainCategory },
              })
            }
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="最小両数">
          <input
            className={styles.narrow}
            data-testid={TID.trainEditMinCars}
            value={train.minCars ?? ''}
            inputMode="numeric"
            onChange={(e) => {
              const value = numberOrUndefined(e.currentTarget.value);
              dispatch({
                type: 'train/update',
                id: train.id,
                patch:
                  value === undefined || value <= 0
                    ? clearing<Omit<Train, 'stops'>>('minCars')
                    : { minCars: value },
              });
            }}
          />
        </Field>
        <Field label="メモ">
          <input
            className={styles.medium}
            data-testid={TID.trainEditNote}
            value={train.note ?? ''}
            onChange={(e) => {
              const text = e.currentTarget.value;
              dispatch({
                type: 'train/update',
                id: train.id,
                patch: text === '' ? clearing<Omit<Train, 'stops'>>('note') : { note: text },
              });
            }}
          />
        </Field>
      </div>

      <div className={styles.chipRow}>
        <span className={styles.hint}>運転日</span>
        {dayTypes.map((dt) => {
          const on = train.dayTypeIds.includes(dt.id);
          return (
            <label key={dt.id} className={styles.checkField}>
              <input
                type="checkbox"
                data-testid={TID.trainEditDayType(dt.id)}
                checked={on}
                onChange={(e) => {
                  const next: DayTypeId[] = e.currentTarget.checked
                    ? [...train.dayTypeIds.filter((id) => id !== dt.id), dt.id]
                    : train.dayTypeIds.filter((id) => id !== dt.id);
                  dispatch({ type: 'train/update', id: train.id, patch: { dayTypeIds: next } });
                }}
              />
              <span>{dt.name}</span>
            </label>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * The confirmation. `findDependants` already knows what points at a train, so
 * the dialog can say "these two duties lose a leg" instead of "are you sure?".
 */
export function TrainDeleteDialog({
  doc,
  train,
  onCancel,
  onConfirm,
}: {
  doc: ProjectDocument;
  train: Train;
  onCancel(): void;
  onConfirm(): void;
}) {
  const dependants = findDependants(doc, 'train', train.id);
  const declaredBy = entityList(doc.trains).filter((t) =>
    t.stops.some(
      (s) => (s.overtakenBy ?? []).includes(train.id) || (s.connectsTo ?? []).includes(train.id),
    ),
  );

  return (
    <div className={grid.dialogBackdrop} role="presentation" onClick={onCancel}>
      <div
        className={grid.dialog}
        data-testid={TID.trainDeleteDialog}
        role="dialog"
        aria-modal="true"
        aria-label="列車の削除"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className={styles.cardTitle}>列車 {trainLabel(doc, train)} を削除しますか？</h2>
        <ul className={grid.dependantList} data-testid={TID.trainDeleteDependants}>
          {dependants.length === 0 && declaredBy.length === 0 ? (
            <li className={styles.hint}>この列車を参照しているものはありません。</li>
          ) : null}
          {dependants.map((d) => (
            <li key={`${d.kind}-${d.id}`}>{d.label} から行路が外れます</li>
          ))}
          {declaredBy.map((t) => (
            <li key={t.id}>列車 {t.number} の待避/接続の指定が外れます</li>
          ))}
        </ul>
        <div className={styles.form}>
          <button type="button" data-testid={TID.trainDeleteCancel} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className={styles.danger}
            data-testid={TID.trainDeleteConfirm}
            onClick={onConfirm}
          >
            削除する
          </button>
        </div>
      </div>
    </div>
  );
}
