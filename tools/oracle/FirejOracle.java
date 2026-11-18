/*
 * Copyright 2008-2026 Vassilios Karakoidas
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;

import org.firej.MatchResult;
import org.firej.RegexCompilationException;
import org.firej.capture.CapturePlan;
import org.firej.dfa.DFA;
import org.firej.dfa.FlattenedDfa;
import org.firej.dfa.FlattenedDfa.Range;
import org.firej.dfa.Preprocessor;
import org.firej.dfa.Preprocessor.Dialect;
import org.firej.dfa.fire.IdentityPreprocessor;
import org.firej.dfa.fire.ParserFire;
import org.firej.runtime.InterpreterRegex;

/**
 * Dumps what FIRE/J's native pipeline makes of every row of a corpus, so that
 * FIRE/JS can be checked against it row for row.
 *
 * <p>Usage: {@code FirejOracle <corpus.data> <escaped: true|false> <out.tsv> <firej-commit>}.
 * Each output row: line number, status ({@code ok}, {@code error:compile:<Exception>}
 * or {@code error:capture-plan}), the two anchor flags, the state count, the
 * group count, the end of the longest match from every offset of the sample
 * input, the group spans of the match at offset 0, and the automaton in the
 * canonical form {@code FlattenedDfa} and the port both produce (or its
 * SHA-256 when long). The last column carries the compile error's message.
 */
public final class FirejOracle {
    private static final Preprocessor PRE = new IdentityPreprocessor(Dialect.EXTENDED);
    private static final ParserFire PARSER = new ParserFire(Dialect.EXTENDED);
    private static final int INLINE_DFA_LIMIT = 4000;

    public static void main(String[] args) throws Exception {
        if (args.length != 4) {
            System.err.println("usage: FirejOracle <corpus.data> <escaped:true|false> <out.tsv> <firej-commit>");
            System.exit(2);
        }
        Path in = Path.of(args[0]);
        boolean escaped = Boolean.parseBoolean(args[1]);
        Path out = Path.of(args[2]);
        List<String> lines = Files.readAllLines(in, StandardCharsets.UTF_8);
        int rows = 0;
        try (PrintWriter w = new PrintWriter(Files.newBufferedWriter(out, StandardCharsets.UTF_8))) {
            w.println("# firej-oracle v1 corpus=" + in.getFileName() + " escaped=" + escaped
                    + " firej=" + args[3] + " java=" + Runtime.version());
            w.println("# line\tstatus\tanchoredStart\tanchoredEnd\tstates\tgroupCount\tends\tgroups\tdfa\tmessage");
            int lineNumber = 0;
            for (String line : lines) {
                lineNumber++;
                if (line.isBlank() || line.startsWith("#")) {
                    continue;
                }
                int tab = line.indexOf('\t');
                if (tab <= 0) {
                    continue;
                }
                String pattern = line.substring(0, tab);
                String input = line.substring(tab + 1);
                if (escaped) {
                    pattern = unescape(pattern);
                    input = unescape(input);
                }
                w.println(row(lineNumber, pattern, input));
                rows++;
            }
        }
        System.err.println(rows + " rows -> " + out);
    }

    private static String row(int line, String pattern, String input) throws Exception {
        FlattenedDfa flat;
        try {
            Preprocessor.Processed p = PRE.process(pattern);
            DFA dfa = PARSER.getDFA(p.expression());
            flat = FlattenedDfa.from(pattern, dfa, p.anchoredStart(), p.anchoredEnd());
        } catch (RuntimeException | StackOverflowError e) {
            return line + "\terror:compile:" + e.getClass().getSimpleName() + "\t\t\t\t\t\t\t\t" + text(e.getMessage());
        }

        int[] ends = new int[input.length() + 1];
        for (int i = 0; i <= input.length(); i++) {
            ends[i] = walk(flat, input, i);
        }

        String status = "ok";
        String groups = "";
        int groupCount = 0;
        try {
            CapturePlan plan = CapturePlan.compile(pattern);
            groupCount = plan.groupCount();
            InterpreterRegex r = new InterpreterRegex(flat, plan);
            r.setData(input);
            for (int i = 0; i <= input.length(); i++) {
                int got = r.exec(i);
                if (got != ends[i]) {
                    throw new IllegalStateException("oracle self-check: line " + line + " offset " + i
                            + ": InterpreterRegex " + got + " vs walk " + ends[i]);
                }
            }
            int end = r.run(input, 0);
            if (end >= 0 && groupCount > 0) {
                MatchResult m = r.getMatchResult();
                StringBuilder g = new StringBuilder();
                for (int i = 1; i <= groupCount; i++) {
                    if (i > 1) {
                        g.append(',');
                    }
                    g.append(m.start(i)).append(':').append(m.end(i));
                }
                groups = g.toString();
            }
        } catch (RegexCompilationException e) {
            status = "error:capture-plan";
        }

        StringBuilder endsText = new StringBuilder();
        for (int i = 0; i < ends.length; i++) {
            if (i > 0) {
                endsText.append(',');
            }
            endsText.append(ends[i]);
        }
        return line + "\t" + status + "\t" + (flat.anchoredStart() ? 1 : 0) + "\t" + (flat.anchoredEnd() ? 1 : 0)
                + "\t" + flat.stateCount() + "\t" + groupCount + "\t" + endsText + "\t" + groups + "\t" + dfa(flat) + "\t";
    }

    /** The end of the longest match from {@code start}, or -1: {@code InterpreterRegex}'s walk, restated. */
    static int walk(FlattenedDfa f, String s, int start) {
        if (f.anchoredStart() && start != 0) {
            return -1;
        }
        boolean[] accept = f.accept();
        Range[][] transitions = f.transitions();
        int state = f.startState();
        int returnValue = accept[state] ? start : -1;
        for (int i = start; i < s.length(); i++) {
            char c = s.charAt(i);
            boolean moved = false;
            for (Range e : transitions[state]) {
                if (c >= e.min() && c <= e.max()) {
                    state = e.dest();
                    if (accept[state]) {
                        returnValue = i + 1;
                    }
                    moved = true;
                    break;
                }
            }
            if (!moved) {
                break;
            }
        }
        return f.anchoredEnd() && returnValue != s.length() ? -1 : returnValue;
    }

    /** The canonical encoding, or its hash when long. Must match {@code FlattenedDfa.encode()} in the port. */
    static String dfa(FlattenedDfa f) throws Exception {
        StringBuilder b = new StringBuilder();
        for (int s = 0; s < f.stateCount(); s++) {
            if (s > 0) {
                b.append(';');
            }
            b.append(f.accept()[s] ? 'A' : '-');
            for (Range r : f.transitions()[s]) {
                b.append(',').append(r.min()).append('-').append(r.max()).append('>').append(r.dest());
            }
        }
        if (b.length() <= INLINE_DFA_LIMIT) {
            return b.toString();
        }
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(b.toString().getBytes(StandardCharsets.UTF_8));
        return "sha256:" + HexFormat.of().formatHex(digest);
    }

    /** One line of text, tabs and newlines escaped, for the message column. */
    private static String text(String s) {
        if (s == null) {
            return "";
        }
        return s.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r");
    }

    /** The corpus escaping of {@code regex101.data}: {@code \t \n \r \\}, anything else is the character. */
    static String unescape(String s) {
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\\' && i + 1 < s.length()) {
                char n = s.charAt(++i);
                b.append(switch (n) {
                    case 't' -> '\t';
                    case 'n' -> '\n';
                    case 'r' -> '\r';
                    case '\\' -> '\\';
                    default -> n;
                });
            } else {
                b.append(c);
            }
        }
        return b.toString();
    }
}
