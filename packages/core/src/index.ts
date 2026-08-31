/**
 * @simplevis/core — isomorphic MVR/GDTF parsing and DMX evaluation.
 *
 * Nothing here touches the DOM, WebGL or Node. That is deliberate: the same
 * code runs in the hosted static build, inside the Tauri webview, and under
 * vitest against real fixture files.
 */

export * from './xml.js';
export * from './matrix.js';
export * from './dmx/address.js';
export * from './gdtf/types.js';
export * from './gdtf/parse.js';
export * from './gdtf/modes.js';
export * from './mvr/types.js';
export * from './mvr/parse.js';
export * from './mvr/archive.js';
export * from './dmx/universe.js';
export * from './dmx/evaluate.js';
export * from './patch.js';
export * from './pixelmap.js';
export * from './dmx/demo.js';
