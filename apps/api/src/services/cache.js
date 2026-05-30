import NodeCache from "node-cache";

// 5-minute TTL for hotel static data (rooms, facilities, packages, settings).
// Invalidated on any write to those resources.
export const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
