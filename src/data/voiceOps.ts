/**
 * 音声で言われた筋トレを、**画面の操作と全く同じ Op** に直す。
 *
 * 音声のときだけ別の保存経路を作らない、というのがここの狙い。
 * 同じ Op になっていれば、そのまま既存の
 *   その場で画面へ反映（applyOp） → 送信待ちに積む（outbox） → 裏で送る
 * に乗る。オフラインでも記録は端末に残る。
 */

import type { AppData } from './types';
import type { Op } from './ops';

export interface VoiceExercise {
  name: string;
  sets: { weight: number; reps: number }[];
}

/**
 * 種目とセットを Op の列にする。
 *
 * **同じ日に同じ種目が既にあれば、そこへセットを足す。**
 * 「ベンチもう2セット」と言い直したときに、同じ種目が二重に並ばないようにする。
 * id は呼び出し時に決める（あとで再適用しても同じ結果になるため）。
 */
export function workoutOps(
  data: AppData,
  date: string,
  exercises: VoiceExercise[],
  newId: () => string,
): Op[] {
  const day = data.workouts.find(workout => workout.date === date);
  const ops: Op[] = [];

  for (const exercise of exercises) {
    const existing = day?.exercises.find(candidate => candidate.name === exercise.name);
    const exerciseId = existing?.id ?? newId();

    if (!existing) {
      ops.push({ kind: 'addExercise', exerciseId, workoutId: `day:${date}`, date, name: exercise.name });
    }
    for (const set of exercise.sets) {
      ops.push({ kind: 'addSet', setId: newId(), exerciseId, weight: set.weight, reps: set.reps });
    }
  }

  return ops;
}
