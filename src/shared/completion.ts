import type { ReviewView } from './contracts';

export function proposalCompletionAt(review: Pick<ReviewView, 'mode' | 'targets' | 'withdrawnAt'>): string | undefined {
  if (review.mode !== 'proposal' || !review.targets.length) return undefined;
  if (review.targets.every(target => target.status === 'saved' && target.receipt)) {
    return review.targets.reduce((latest, target) => target.receipt!.savedAt > latest ? target.receipt!.savedAt : latest, '');
  }
  if (review.withdrawnAt && review.targets.every(target => target.status === 'withdrawn')) return review.withdrawnAt;
  return undefined;
}
