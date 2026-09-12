// @katnor/artifacts - artifact storage (MinIO in prod, local FS in dev) and
// viewer metadata for files, diffs, PRs, docs, images, designs, links, and
// reports. See PLAN.md section 4.6.
//
// TODO: implemented in a later phase

export const ARTIFACTS_PACKAGE_NAME = '@katnor/artifacts';

export type ArtifactKind = 'file' | 'diff' | 'pr' | 'doc' | 'image' | 'design' | 'link' | 'report';
