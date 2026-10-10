import { appIcon } from "@/lib/app-icon";

const SIZES = new Set([192, 512]);

export async function GET(_request: Request, { params }: { params: Promise<{ size: string }> }) {
  const size = Number((await params).size);
  if (!SIZES.has(size)) return new Response("Not found", { status: 404 });
  const image = appIcon(size);
  image.headers.set("Cache-Control", "public, max-age=86400");
  return image;
}
