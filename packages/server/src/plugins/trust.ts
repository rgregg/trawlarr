/**
 * What every surface that installs code says out loud, in ONE wording.
 *
 * Adding a source is the TRUST decision; syncing is where it takes effect,
 * because loading a plugin to validate it runs its module body — as the
 * trawlarr user, with this service's access to the library. That is a
 * consequence, so it is named rather than left in the documentation.
 *
 * It lives here rather than in the CLI because it is now said in two places:
 * the CLI prints it, and the API returns it in the body of the two requests
 * that take the decision, so a UI built on this API can show the operator the
 * same sentence at the same moment instead of inventing a softer one.
 */
export const PLUGIN_TRUST_CONSEQUENCE =
  `Installing a plugin runs its author's code on this machine as the same user trawlarr runs ` +
  `as: syncing loads each plugin to validate it, and a flow that names one runs the rest of it ` +
  `with this service's access to your media. Add sources you would trust with your library.`;
