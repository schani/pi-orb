/**
 * True for an exact global Compute image resource. Families are moving aliases
 * and therefore cannot participate in an immutable host specification.
 */
export function isExactGceImageResource(image: string): boolean {
  return /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/global\/images\/[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(
    image,
  );
}

export function isNumericGceImageId(imageId: string): boolean {
  return /^[1-9][0-9]*$/.test(imageId);
}

export type GceImageIdentity =
  | {
      readonly ok: true;
      readonly imageResource: string;
      readonly imageId: string;
      readonly workspaceImageResource: string;
      readonly workspaceImageId: string;
    }
  | { readonly ok: false; readonly message: string };

export function readGceImageIdentity(read: (name: string) => string): GceImageIdentity {
  const imageResource = read("PI_ORB_GCE_IMAGE_RESOURCE");
  const imageId = read("PI_ORB_GCE_IMAGE_ID");
  const workspaceImageResource = read("PI_ORB_GCE_WORKSPACE_IMAGE_RESOURCE");
  const workspaceImageId = read("PI_ORB_GCE_WORKSPACE_IMAGE_ID");
  return isExactGceImageResource(imageResource) &&
    isNumericGceImageId(imageId) &&
    isExactGceImageResource(workspaceImageResource) &&
    isNumericGceImageId(workspaceImageId)
    ? { ok: true, imageResource, imageId, workspaceImageResource, workspaceImageId }
    : {
        ok: false,
        message:
          "GCE runtime and workspace image resources must name exact images and their image IDs must be numeric",
      };
}
