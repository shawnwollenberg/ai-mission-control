import brandSheet from "../MCImages.png";

type BrandAsset = "mark-primary" | "mark-compact" | "agent-research" | "agent-coding" | "agent-testing" | "agent-deployment";

export function BrandSprite({ asset, className = "" }: { asset: BrandAsset; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`brand-sprite brand-${asset} ${className}`}
      style={{ backgroundImage: `url(${brandSheet.src})` }}
    />
  );
}
