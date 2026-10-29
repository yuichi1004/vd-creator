// Types the UI uses, all derived from the API types of @vd-creator/server, so that the UI
// depends on the server's API only.

import type { GeneratePlanResponse, LibraryEntryInfo, ProjectResponse } from "@vd-creator/server";

export type Timeline = NonNullable<ProjectResponse["timeline"]>;
export type TimelineItem = Timeline["items"][number];
export type ImageSpan = Timeline["images"][number];
export type BgmSpan = Timeline["bgm"][number];

export type Scenario = NonNullable<ProjectResponse["scenario"]>;
export type Scene = Scenario["scenes"][number];
export type Item = Scene["items"][number];
export type LineItem = Extract<Item, { line: string }>;
export type SfxItem = Extract<Item, { sfx: unknown }>;
export type Bgm = NonNullable<Scene["bgm"]>;
export type Speaker = Scenario["speakers"][number];

export type Issue = ProjectResponse["issues"][number];
export type LicenseIssue = ProjectResponse["licenseIssues"][number];
export type LibraryKind = LibraryEntryInfo["kind"];
export type GenerationPlan = GeneratePlanResponse["plan"];
