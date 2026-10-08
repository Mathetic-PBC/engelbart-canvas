import React from 'react';
import { errorMessage } from '../api.js';

/**
 * An add's busy and error (MATH-44, out of Rail.jsx AddToLibrary): `run(work)` waits on `work`, which may return
 * problems; they are shown, joined, else `done` is called. A throw is shown the same way. The bottom "+ Add context",
 * the home page's library and the sections' +'s each hold one.
 */
export function useAddRun(done) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const doneRef = React.useRef(done);
  doneRef.current = done;
  const run = async (work) => {
    setBusy(true);
    setError('');
    try {
      const problems = await work();
      if (problems && problems.length) setError(problems.join(' · '));
      else if (doneRef.current) doneRef.current();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}
