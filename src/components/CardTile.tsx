import Link from 'next/link';
import { CardArt } from './CardArt';
import { money } from '@/lib/pricing/quote';
import { VARIANT_SHORT, type Variant } from '@/lib/catalog/variants';

export interface TileCard {
  cardId: string;
  name: string;
  number: string;
  variant?: string | null;
  imageSmall: string | null;
  marketCents?: number | null;
  owned?: boolean;
}

/**
 * The card, as the product's atom.
 *
 * Every surface that shows cards uses this: rails on Home, the missing list,
 * move evidence, trade matches. One component means one aspect ratio, one
 * ghosting treatment for an absent card, and one place to change how a card
 * reads.
 */
export function CardTile({
  card,
  width = 'w-[76px]',
  href,
  showPrice = true,
  priority = false,
}: {
  card: TileCard;
  width?: string;
  href?: string;
  showPrice?: boolean;
  priority?: boolean;
}) {
  const owned = card.owned ?? true;
  const variantTag =
    card.variant && card.variant !== 'normal' ? VARIANT_SHORT[card.variant as Variant] : null;

  const body = (
    <>
      <div className="relative">
        <CardArt
          src={card.imageSmall}
          alt={card.name}
          owned={owned}
          label={`#${card.number}`}
          priority={priority}
        />
        {variantTag && (
          <span className="absolute left-1 top-1 rounded bg-ink/85 px-1 py-0.5 text-[8px] font-bold uppercase tracking-wide text-ink-mute backdrop-blur">
            {variantTag}
          </span>
        )}
      </div>
      <div className="mt-1.5 h-[26px]">
        <p className="num truncate text-[10px] leading-tight text-ink-mute">#{card.number}</p>
        {showPrice && (
          <p className="num truncate text-[11px] font-bold leading-tight">
            {card.marketCents === null || card.marketCents === undefined ? (
              <span className="text-ink-dim">—</span>
            ) : (
              money(card.marketCents)
            )}
          </p>
        )}
      </div>
    </>
  );

  if (href) {
    return (
      <Link href={href} className={`${width} shrink-0 transition active:scale-[.97]`}>
        {body}
      </Link>
    );
  }
  return <div className={`${width} shrink-0`}>{body}</div>;
}
