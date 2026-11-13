// Pass sırası: önce çalışma anı katmanları, sonra statik sadeleştirmeler; her tur bu sırayla döner.
import * as layers from '../passes/layers.js';
import * as iife from '../passes/iife.js';
import * as proxify from '../passes/proxify.js';
import * as fold from '../passes/fold.js';
import * as propagate from '../passes/propagate.js';
import * as strings from '../passes/strings.js';
import * as dead from '../passes/dead.js';
import * as unused from '../passes/unused.js';
import * as rename from '../passes/rename.js';

export const PASSES = [layers, iife, proxify, propagate, fold, strings, dead, unused, rename];
