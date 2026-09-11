/**
 * Store registry (requirements doc §17).
 * Adding a store later (stores/bookwalker.js, stores/amazon.js, …) means
 * implementing a StoreAdapter and registering it here.
 */

import { DLsiteAdapter } from './dlsite.js';
import { FanzaAdapter } from './fanza.js';
import { MelonbooksAdapter } from './melonbooks.js';
import { PixivAdapter } from './pixiv.js';
import { FantiaAdapter } from './fantia.js';

/** Search order: DLsite first (largest Japanese catalogue), then FANZA / Melonbooks when nothing is convincing */
const factories = new Map([
  ['dlsite', () => new DLsiteAdapter()],
  ['fanza', () => new FanzaAdapter()],
  ['melonbooks', () => new MelonbooksAdapter()],
  ['pixiv', () => new PixivAdapter()],
  ['fantia', () => new FantiaAdapter()]
]);

const instances = new Map();

export function getAdapter(id = 'dlsite') {
  const key = factories.has(id) ? id : 'dlsite';
  if (!instances.has(key)) instances.set(key, factories.get(key)());
  return instances.get(key);
}

export function listStores() {
  return [...factories.keys()];
}
