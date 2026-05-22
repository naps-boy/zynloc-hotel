/**
 * Dijkstra shortest-path on a waypoint graph.
 * waypoints:   [{ id, name, x, y, photo_url, waypoint_type }]
 * connections: [{ from_waypoint_id, to_waypoint_id, distance, direction_hint }]
 * Returns: { path: [waypointId, ...], steps: [{ waypoint, hint }] }
 *         or null if no path found.
 */
export function findPath(waypoints, connections, fromId, toId) {
  if (fromId === toId) return { path: [fromId], steps: [] };

  // Build adjacency map: nodeId → [{ to, distance, hint }]
  const adj = {};
  for (const w of waypoints) adj[w.id] = [];
  for (const c of connections) {
    if (!adj[c.from_waypoint_id]) adj[c.from_waypoint_id] = [];
    adj[c.from_waypoint_id].push({
      to: c.to_waypoint_id,
      dist: Number(c.distance) || 1,
      hint: c.direction_hint || ""
    });
  }

  const dist  = {};
  const prev  = {};
  const hints = {};
  const visited = new Set();

  for (const w of waypoints) dist[w.id] = Infinity;
  dist[fromId] = 0;

  // Simple min-heap via sorted array (small graphs — fine for hotel use)
  const queue = [{ id: fromId, d: 0 }];

  while (queue.length) {
    queue.sort((a, b) => a.d - b.d);
    const { id: u } = queue.shift();
    if (visited.has(u)) continue;
    visited.add(u);
    if (u === toId) break;

    for (const { to, dist: edgeDist, hint } of (adj[u] || [])) {
      const alt = dist[u] + edgeDist;
      if (alt < dist[to]) {
        dist[to] = alt;
        prev[to] = u;
        hints[to] = hint;
        queue.push({ id: to, d: alt });
      }
    }
  }

  if (dist[toId] === Infinity) return null;

  // Reconstruct path
  const path = [];
  let cur = toId;
  while (cur !== undefined) {
    path.unshift(cur);
    cur = prev[cur];
  }

  const waypointMap = Object.fromEntries(waypoints.map((w) => [w.id, w]));
  const steps = path.slice(1).map((id, i) => ({
    waypoint: waypointMap[id],
    hint:     hints[id] || "Continue ahead"
  }));

  return { path, steps, totalDistance: dist[toId] };
}
