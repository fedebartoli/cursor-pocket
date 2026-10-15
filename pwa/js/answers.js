// Answer state for an `ask_question` questionnaire: pure logic, no DOM (testable in Node).
//
// Rules (same checks as daemon `validateAnswers`):
//  - single choice: one option OR "Other" with text; tapping the selected option again does not deselect
//    (unlike Cursor, this is a normal "radio" group);
//  - multiple choice: any combination of options plus "Other" with text;
//  - "Other" selected requires non-empty text.

export const FREEFORM_MAX = 4000; // same as daemon LIMITS.freeformChars

export class AnswerState {
  /** @param {{questions: {id: string, options: {id: string}[], allowMultiple?: boolean}[]}} question */
  constructor(question) {
    this.question = question;
    this.items = new Map((question?.questions ?? []).map((q) => [q.id, { ids: new Set(), other: false, text: '' }]));
  }

  #q(qid) {
    return this.question.questions.find((q) => q.id === qid) ?? null;
  }

  isSelected(qid, optionId) {
    return Boolean(this.items.get(qid)?.ids.has(optionId));
  }

  isOther(qid) {
    return Boolean(this.items.get(qid)?.other);
  }

  text(qid) {
    return this.items.get(qid)?.text ?? '';
  }

  /** Tap on an option. Returns false if the question or option does not exist. */
  toggle(qid, optionId) {
    const q = this.#q(qid);
    const it = this.items.get(qid);
    if (!q || !it || !q.options.some((o) => o.id === optionId)) return false;
    if (q.allowMultiple) {
      if (it.ids.has(optionId)) it.ids.delete(optionId);
      else it.ids.add(optionId);
    } else {
      it.ids = new Set([optionId]);
      it.other = false;
    }
    return true;
  }

  /** Tap on "Other". Returns the "Other" state after the tap. */
  toggleOther(qid) {
    const q = this.#q(qid);
    const it = this.items.get(qid);
    if (!q || !it) return false;
    if (q.allowMultiple) {
      it.other = !it.other;
    } else {
      it.other = true;
      it.ids.clear();
    }
    return it.other;
  }

  setText(qid, text) {
    const it = this.items.get(qid);
    if (it) it.text = String(text ?? '').slice(0, FREEFORM_MAX);
  }

  isQuestionComplete(qid) {
    const it = this.items.get(qid);
    if (!it) return false;
    if (it.other && !it.text.trim()) return false;
    return it.ids.size > 0 || it.other;
  }

  /** How many questions still lack a valid answer. */
  missing() {
    return (this.question?.questions ?? []).filter((q) => !this.isQuestionComplete(q.id)).length;
  }

  isComplete() {
    return (this.question?.questions?.length ?? 0) > 0 && this.missing() === 0;
  }

  /** Body of the `answer` request. Option order follows the question. */
  payload() {
    return this.question.questions.map((q) => {
      const it = this.items.get(q.id);
      return {
        questionId: q.id,
        optionIds: q.options.filter((o) => it.ids.has(o.id)).map((o) => o.id),
        freeform: it.other ? it.text.trim() : '',
      };
    });
  }
}

/** Option letter (A, B, C...), like Cursor badges. Beyond 26 options use the number. */
export function optionBadge(index) {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}
