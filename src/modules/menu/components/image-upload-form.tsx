"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ImageOff, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  removeComboImageAction,
  removeProductImageAction,
  uploadComboImageAction,
  uploadProductImageAction,
  type MenuActionState,
} from "@/modules/menu/actions";
import { FieldError, FormError, FormSuccess } from "@/components/forms/form-bits";

/**
 * Image upload for products and combos. Files are validated (type + size)
 * and stored under menu-media/{business_id}/{entity_id}/… — the storage
 * policies scope writes to that business's members.
 */
export function ImageUploadForm({
  businessId,
  targetId,
  kind,
  imageUrl,
}: {
  businessId: string;
  targetId: string;
  kind: "product" | "combo";
  imageUrl: string | null;
}) {
  const router = useRouter();
  const uploadAction = kind === "product" ? uploadProductImageAction : uploadComboImageAction;
  const removeAction = kind === "product" ? removeProductImageAction : removeComboImageAction;
  const idField = kind === "product" ? "productId" : "comboId";

  const [uploadState, uploadFormAction, uploadPending] = useActionState<MenuActionState | undefined, FormData>(
    uploadAction,
    undefined,
  );
  const [removeState, removeFormAction, removePending] = useActionState<MenuActionState | undefined, FormData>(
    removeAction,
    undefined,
  );

  useEffect(() => {
    if (uploadState?.ok || removeState?.ok) router.refresh();
  }, [uploadState, removeState, router]);

  return (
    <div className="space-y-4">
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt="Current menu image" className="h-40 w-full rounded-xl object-cover" />
      ) : (
        <div className="flex h-40 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-ink/20 text-muted-foreground">
          <ImageOff className="size-6" aria-hidden />
          <span className="text-xs">No image yet — JPEG, PNG or WebP up to 5 MB</span>
        </div>
      )}

      <form action={uploadFormAction} className="space-y-2">
        <input type="hidden" name="businessId" value={businessId} />
        <input type="hidden" name={idField} value={targetId} />
        <input
          type="file"
          name="image"
          accept="image/jpeg,image/png,image/webp"
          required
          aria-label="Choose an image"
          className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-ink file:px-4 file:py-2 file:text-sm file:text-cream hover:file:bg-ink-soft"
        />
        <FormError state={uploadState} />
        <FormSuccess message={uploadState?.ok ? "Image uploaded." : undefined} />
        <FieldError state={uploadState} name="image" />
        <Button type="submit" variant="outline" size="sm" disabled={uploadPending}>
          <Upload className="size-4" aria-hidden /> {uploadPending ? "Uploading…" : imageUrl ? "Replace image" : "Upload image"}
        </Button>
      </form>

      {imageUrl ? (
        <form action={removeFormAction}>
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name={idField} value={targetId} />
          <button
            type="submit"
            disabled={removePending}
            className="text-xs text-muted-foreground underline-offset-4 hover:text-destructive hover:underline disabled:opacity-50"
          >
            Remove image
          </button>
        </form>
      ) : null}
    </div>
  );
}
