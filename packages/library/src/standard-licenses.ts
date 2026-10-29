import type { LicenseRegistry } from "./schema.js";

/**
 * The standard Creative Commons licenses, version 4.0, whose terms are fixed. `initLibrary`
 * writes them to licenses.yaml. Site-specific and provider licenses are the user's to add.
 */
export const STANDARD_LICENSES: LicenseRegistry = {
  "CC0-1.0": {
    name: "Creative Commons Zero 1.0",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
    attribution: "none",
    commercialUse: "allowed",
    modification: "allowed",
    shareAlike: false,
  },
  "CC-BY-4.0": {
    name: "Creative Commons Attribution 4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
    attribution: "required",
    commercialUse: "allowed",
    modification: "allowed",
    shareAlike: false,
  },
  "CC-BY-SA-4.0": {
    name: "Creative Commons Attribution-ShareAlike 4.0",
    url: "https://creativecommons.org/licenses/by-sa/4.0/",
    attribution: "required",
    commercialUse: "allowed",
    modification: "allowed",
    shareAlike: true,
  },
  "CC-BY-NC-4.0": {
    name: "Creative Commons Attribution-NonCommercial 4.0",
    url: "https://creativecommons.org/licenses/by-nc/4.0/",
    attribution: "required",
    commercialUse: "forbidden",
    modification: "allowed",
    shareAlike: false,
  },
  "CC-BY-NC-SA-4.0": {
    name: "Creative Commons Attribution-NonCommercial-ShareAlike 4.0",
    url: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
    attribution: "required",
    commercialUse: "forbidden",
    modification: "allowed",
    shareAlike: true,
  },
};
