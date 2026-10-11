// Stato delle risposte a un questionario di `ask_question`: logica pura, senza DOM (si prova in Node).
//
// Regole (le stesse controllate dal daemon in `validateAnswers`):
//  - scelta singola: una sola opzione OPPURE "Altro" con testo; toccare di nuovo l'opzione scelta non la toglie
//    (a differenza di Cursor, qui e' un normale gruppo "radio");
//  - scelta multipla: qualunque combinazione di opzioni piu' "Altro" con testo;
//  - "Altro" scelto richiede un testo non vuoto.

export const FREEFORM_MAX = 4000; // come LIMITS.freeformChars del daemon

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

  /** Tocco su un'opzione. Ritorna false se la domanda o l'opzione non esistono. */
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

  /** Tocco su "Altro". Ritorna lo stato di "Altro" dopo il tocco. */
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

  /** Quante domande non hanno ancora una risposta valida. */
  missing() {
    return (this.question?.questions ?? []).filter((q) => !this.isQuestionComplete(q.id)).length;
  }

  isComplete() {
    return (this.question?.questions?.length ?? 0) > 0 && this.missing() === 0;
  }

  /** Corpo della richiesta `answer`. L'ordine delle opzioni segue quello della domanda. */
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

/** Lettera dell'opzione (A, B, C...), come i badge di Cursor. Oltre le 26 opzioni si usa il numero. */
export function optionBadge(index) {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}
