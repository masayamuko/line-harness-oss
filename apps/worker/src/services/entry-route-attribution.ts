/**
 * Entry Route Attribution Helper
 *
 * `/auth/line?ref=xxx` で訪問した friend に対し、entry_routes の設定に基づき
 * - ref_code の first-touch 保存
 * - tag 付与
 * - tag_added trigger scenario への enroll
 * - tag_change event fire
 * - direct scenario_id への enroll（tag 経由でない場合）
 * を一括で実行する。
 *
 * `/api/friends/:id/tags`（friends.ts:203 付近）が tag_added scenario enroll と
 * tag_change event fire を実行しているため、`addTagToFriend()` を直接呼ぶ
 * `/auth/callback`（liff.ts:544 付近）からは scenario が起動しない問題があった。
 * このhelperで集約することで、ref保存経路（liff.ts:544 / 917 / 970）すべてで
 * 一貫した自動配信が動作するようにする。
 *
 * First-touch wins: 既に別の ref_code が記録されている friend が新しい ref で
 * 訪問しても、attribution は最初のもの優先（ref_code 上書きしない・tag 追加しない）。
 */

import {
  addTagToFriend,
  enrollFriendInScenario,
  getEntryRouteByRefCode,
  getScenarios,
} from '@line-crm/db';
import { fireEvent } from './event-bus.js';

export interface ApplyEntryRouteResult {
  /** xh: prefix だった or ref 空で何もしなかった場合 false */
  processed: boolean;
  /** first-touch整合（既に別refが記録されていた場合）で attribution をskipした場合 true */
  skippedByFirstTouch: boolean;
  /** entry_route が見つかった場合の id */
  routeId: string | null;
  /** tag付与に成功した場合 true */
  tagAdded: boolean;
  /** scenario enroll に成功した場合 true */
  scenarioEnrolled: boolean;
  /** 非致命エラーのリスト（処理は続行される） */
  errors: string[];
}

/**
 * Apply entry route attribution to a friend based on a ref code.
 *
 * @param db D1 database binding
 * @param friendId target friend.id
 * @param ref ref code from query string (e.g. "site-ai-renewal")
 * @param lineAccessToken optional LINE channel access token for fireEvent's webhook dispatch
 * @param lineAccountId optional account id for fireEvent
 * @returns detailed result; non-fatal errors are collected in `errors`
 */
export async function applyEntryRouteAttribution(
  db: D1Database,
  friendId: string,
  ref: string | null | undefined,
  lineAccessToken?: string,
  lineAccountId?: string | null,
): Promise<ApplyEntryRouteResult> {
  const result: ApplyEntryRouteResult = {
    processed: false,
    skippedByFirstTouch: false,
    routeId: null,
    tagAdded: false,
    scenarioEnrolled: false,
    errors: [],
  };

  // X Harness one-time tokens are never persisted as ref_code; they have a separate flow.
  if (!ref || ref.startsWith('xh:')) {
    return result;
  }
  result.processed = true;

  // First-touch wins: only set ref_code if not already set.
  const updateResult = await db
    .prepare(`UPDATE friends SET ref_code = ? WHERE id = ? AND ref_code IS NULL`)
    .bind(ref, friendId)
    .run();

  const changes =
    (updateResult.meta as { changes?: number } | undefined)?.changes ?? 0;

  if (changes === 0) {
    // Either friend not found, or ref_code already set. Verify it matches.
    const existing = await db
      .prepare(`SELECT ref_code FROM friends WHERE id = ?`)
      .bind(friendId)
      .first<{ ref_code: string | null }>();

    if (!existing || existing.ref_code !== ref) {
      // Different ref already attributed — respect first-touch and skip.
      result.skippedByFirstTouch = true;
      return result;
    }
    // Same ref re-visit: continue applying attribution (idempotent paths below).
  }

  // Look up entry_route configuration for this ref.
  const route = await getEntryRouteByRefCode(db, ref);
  if (!route) {
    // No route configured — tracking only (caller handles recordRefTracking).
    return result;
  }
  result.routeId = route.id;

  // Apply tag and trigger tag_added scenario(s).
  if (route.tag_id) {
    try {
      await addTagToFriend(db, friendId, route.tag_id);
      result.tagAdded = true;

      // Mirror /api/friends/:id/tags behavior (friends.ts:203): enroll into
      // tag_added scenarios that match this tag, skipping already-enrolled.
      const allScenarios = await getScenarios(db);
      for (const scenario of allScenarios) {
        if (
          scenario.trigger_type === 'tag_added' &&
          scenario.is_active &&
          scenario.trigger_tag_id === route.tag_id
        ) {
          const existing = await db
            .prepare(
              `SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`,
            )
            .bind(friendId, scenario.id)
            .first();
          if (!existing) {
            await enrollFriendInScenario(db, friendId, scenario.id);
            result.scenarioEnrolled = true;
          }
        }
      }

      // Fire tag_change event so automations / notifications / webhooks see it.
      await fireEvent(
        db,
        'tag_change',
        {
          friendId,
          eventData: { tagId: route.tag_id, action: 'add' },
        },
        lineAccessToken,
        lineAccountId,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`tag/scenario application failed: ${msg}`);
      console.error('applyEntryRouteAttribution: tag path error', err);
    }
  }

  // Direct scenario_id (when an entry_route specifies a scenario without a tag).
  if (route.scenario_id && !result.scenarioEnrolled) {
    try {
      const existing = await db
        .prepare(
          `SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`,
        )
        .bind(friendId, route.scenario_id)
        .first();
      if (!existing) {
        await enrollFriendInScenario(db, friendId, route.scenario_id);
        result.scenarioEnrolled = true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`direct scenario enrollment failed: ${msg}`);
      console.error(
        'applyEntryRouteAttribution: direct scenario error',
        err,
      );
    }
  }

  return result;
}
