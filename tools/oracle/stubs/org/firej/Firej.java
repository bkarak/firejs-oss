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
package org.firej;

import org.firej.capture.CapturePlan;
import org.firej.dfa.DFA;
import org.firej.dfa.FlattenedDfa;
import org.firej.dfa.Preprocessor;
import org.firej.dfa.Preprocessor.Dialect;
import org.firej.dfa.fire.IdentityPreprocessor;
import org.firej.dfa.fire.ParserFire;
import org.firej.runtime.InterpreterRegex;

/**
 * The oracle's stand-in for FIRE/J's {@code Firej} facade, placed ahead of the
 * real one on javac's source path so that {@code Regex.compile} resolves
 * without ASM or dk.brics.automaton: the native pipeline and the interpreter,
 * which is all the oracle needs. Every other FIRE/J class is compiled from the
 * library's own sources, unchanged.
 */
public final class Firej {
    private static final Firej STANDARD = new Firej();

    public static Firej standard() {
        return STANDARD;
    }

    public Regex compile(String pattern) {
        Preprocessor.Processed p = new IdentityPreprocessor(Dialect.EXTENDED).process(pattern);
        DFA dfa = new ParserFire(Dialect.EXTENDED).getDFA(p.expression());
        FlattenedDfa flat = FlattenedDfa.from(pattern, dfa, p.anchoredStart(), p.anchoredEnd());
        return new InterpreterRegex(flat, CapturePlan.compile(pattern));
    }
}
