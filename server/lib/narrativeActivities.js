// A narrow activity check, not a factual accuracy classifier.
const patterns = {
  prepare: /\b(?:prepare|preparing|preparation|prep)\b/i,
  call: /\b(?:calls?|tc|telephone conference)\b/i,
  correspond: /\b(?:emails?|messages?|msgs|transmit|send|distribute|circulate|correspond(?:ence)?|communicat(?:e|ions?))\b/i,
  confer: /\b(?:confer|conf|consult|consultation|conference with client)\b/i,
  review: /\b(?:review|analyze|analysis|examine|rna)\b/i,
  revise: /\b(?:revise|revising|edit|editing)\b/i,
  draft: /\b(?:draft|drafting)\b/i,
  research: /\b(?:research|researching)\b/i,
};
export function activityIssues(input, output) {
  const source = new Set(Object.entries(patterns).filter(([,r])=>r.test(input)).map(([k])=>k));
  const result = new Set(Object.entries(patterns).filter(([,r])=>r.test(output)).map(([k])=>k));
  const ambiguousReview = /\brev\b/i.test(input);
  const missing = [...source].filter(k=>!result.has(k));
  if (ambiguousReview && !result.has('review') && !result.has('revise')) missing.push('review/revise');
  const added = [...result].filter(k=>!source.has(k) && !(k==='call' && source.has('prepare') && result.has('prepare') && !/\b(?:participate|conduct|attend|hold|initiate|join)\b/i.test(output)) && !(ambiguousReview && ['review','revise'].includes(k)) && !(k==='review' && (source.has('prepare') || source.has('revise'))));
  return {missing,added,ok:!missing.length&&!added.length};
}
