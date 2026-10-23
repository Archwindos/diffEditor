import type { ReviewView, SaveReceipt } from '../shared/contracts';

export function retainedReceiptFor(review: ReviewView): SaveReceipt | undefined {
  return review.targets
    .filter(target => target.status === 'saved' && target.receipt && review[target.receipt.side].targetId === target.id)
    .map(target => target.receipt!)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0];
}

export function hasOtherUnfinishedFile(review: ReviewView, receipt: SaveReceipt): boolean {
  const other = receipt.side === 'left' ? 'right' : 'left';
  if (review[other].targetId === review[receipt.side].targetId) return false;
  const target = review.targets.find(target => target.id === review[other].targetId);
  return !target || !['saved', 'saving', 'rejected'].includes(target.status);
}
