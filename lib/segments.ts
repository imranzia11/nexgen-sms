// SMS segment counting, matching how carriers/Twilio split a message.
//
// GSM-7 text: 160 characters in one segment, 153 per segment once split.
// Any character outside GSM-7 (emoji, curly quotes, most non-Latin text)
// switches the whole message to UCS-2: 70 characters in one segment, 67 per
// segment once split. GSM-7 extension characters ({ } [ ] ~ ^ \ | and the
// euro sign) take two character slots.

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€\f";

export function countSegments(text: unknown): number {
  const value = String(text ?? "");
  if (!value) return 1;

  let gsmLength = 0;
  let isGsm = true;

  for (const ch of value) {
    if (GSM_BASIC.includes(ch)) {
      gsmLength += 1;
    } else if (GSM_EXTENDED.includes(ch)) {
      gsmLength += 2;
    } else {
      isGsm = false;
      break;
    }
  }

  if (isGsm) {
    return gsmLength <= 160 ? 1 : Math.ceil(gsmLength / 153);
  }

  const ucsLength = value.length; // UTF-16 code units, as UCS-2 counts them
  return ucsLength <= 70 ? 1 : Math.ceil(ucsLength / 67);
}
