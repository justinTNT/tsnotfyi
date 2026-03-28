// Ratings & play stats handlers — D1
import { json } from '../router.js';

export async function handleRate({ request, params, env }) {
  const { id } = params;
  const body = await request.json();
  const rating = body.rating;

  if (rating === undefined || ![-1, 0, 1].includes(rating)) {
    return json({ error: 'rating must be -1, 0, or 1' }, 400);
  }

  if (rating === 0) {
    await env.DB.prepare('DELETE FROM ratings WHERE identifier = ?1').bind(id).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO ratings (identifier, rating, rated_at) VALUES (?1, ?2, datetime(\'now\')) ON CONFLICT(identifier) DO UPDATE SET rating = ?2, rated_at = datetime(\'now\')'
    ).bind(id, rating).run();
  }

  return json({ ok: true, identifier: id, rating });
}

export async function handleComplete({ params, env }) {
  const { id } = params;

  await env.DB.prepare(
    'INSERT INTO play_stats (identifier, completion_count, last_completed) VALUES (?1, 1, datetime(\'now\')) ON CONFLICT(identifier) DO UPDATE SET completion_count = completion_count + 1, last_completed = datetime(\'now\')'
  ).bind(id).run();

  return json({ ok: true, identifier: id });
}

export async function handleTrackCompleted({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const id = body.identifier;
  if (!id) return json({ error: 'identifier required' }, 400);

  await env.DB.prepare(
    'INSERT INTO play_stats (identifier, completion_count, last_completed) VALUES (?1, 1, datetime(\'now\')) ON CONFLICT(identifier) DO UPDATE SET completion_count = completion_count + 1, last_completed = datetime(\'now\')'
  ).bind(id).run();

  return json({ ok: true, identifier: id });
}

export async function handleTrackStats({ params, env }) {
  const { id } = params;

  const rating = await env.DB.prepare('SELECT rating FROM ratings WHERE identifier = ?1').bind(id).first();
  const stats = await env.DB.prepare('SELECT completion_count, last_completed FROM play_stats WHERE identifier = ?1').bind(id).first();

  return json({
    identifier: id,
    rating: rating?.rating || 0,
    completionCount: stats?.completion_count || 0,
    lastCompleted: stats?.last_completed || null
  });
}
