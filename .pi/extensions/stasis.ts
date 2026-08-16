/**
 * Project-local hook so `pi` run inside this repository loads the extension under
 * development, without an install step or a `-e` flag.
 *
 * The experiment runner deliberately sets `noExtensions: true` and supplies its own
 * factory, so this file cannot leak into a trial and contaminate the control arm.
 */

export { default } from "../../src/extension.ts";
