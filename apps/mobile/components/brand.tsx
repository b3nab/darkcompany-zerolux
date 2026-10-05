import Svg, { Circle, Path } from "react-native-svg";
import { useCSSVariable } from "uniwind";
import { mark, stroke, wordmark } from "@zerolux/theme/logo";

/** The logo's own inks for the current theme. */
function useInks() {
  const [ink, dot] = useCSSVariable(["--color-logo-ink", "--color-logo-dot"]);
  return { ink: String(ink), dot: String(dot) };
}

/** The wordmark: "zerolux" with the mark as its "o". */
export function Wordmark({ height = 18 }: { height?: number }) {
  const { ink, dot } = useInks();
  return (
    <Svg
      width={height * wordmark.ratio}
      height={height}
      viewBox={wordmark.viewBox}
      accessibilityLabel="ZeroLux"
    >
      <Path d={wordmark.letters} fill={ink} />
      <Path d={wordmark.ring} fill="none" stroke={ink} strokeWidth={stroke} />
      <Circle {...wordmark.dot} fill={dot} />
    </Svg>
  );
}

/** The mark alone. */
export function Mark({ size = 24 }: { size?: number }) {
  const { ink, dot } = useInks();
  return (
    <Svg
      width={size}
      height={size}
      viewBox={mark.viewBox}
      accessibilityLabel="ZeroLux"
    >
      <Path d={mark.ring} fill="none" stroke={ink} strokeWidth={stroke} />
      <Circle {...mark.dot} fill={dot} />
    </Svg>
  );
}
