'use client';

import { MotionConfig, motion, useReducedMotion } from 'motion/react';
import type { Variants } from 'motion/react';
import { BotCard, type BotCardProps } from './bot-card';
import { NewBotCard, type NewBotCardProps } from './new-bot-card';
import { DURATION, EASE, STAGGER } from '../../lib/motion';

const LIST: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: STAGGER } },
};

const CARD: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: DURATION.base, ease: EASE } },
};

export interface BotGalleryItem extends BotCardProps {
  readonly id: string;
}

export interface BotGalleryProps {
  readonly bots: readonly BotGalleryItem[];
  readonly newBot: Omit<NewBotCardProps, 'headingId'>;
}

/**
 * The gallery grid: Bot cards plus the dashed new-Bot card.
 *
 * Cards arrive with one short staggered fade. Reduced motion drops the
 * entrance entirely; nothing waits for it.
 */
export function BotGallery({ bots, newBot }: Readonly<BotGalleryProps>) {
  const reduceMotion = useReducedMotion();

  return (
    <MotionConfig reducedMotion="user">
      <motion.ul
        variants={LIST}
        initial={reduceMotion === true ? false : 'hidden'}
        animate="show"
        className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 lg:gap-5"
      >
        {bots.map(({ id, ...card }) => (
          <motion.li key={id} variants={CARD} className="min-w-0">
            <BotCard {...card} />
          </motion.li>
        ))}

        <motion.li variants={CARD} className="min-w-0">
          <NewBotCard {...newBot} headingId="new-bot-title" />
        </motion.li>
      </motion.ul>
    </MotionConfig>
  );
}
