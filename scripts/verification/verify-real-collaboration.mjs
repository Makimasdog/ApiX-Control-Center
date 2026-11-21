import {main} from '../evaluation/evaluate-native-collaboration.mjs';

main().then(code=>process.exitCode=code).catch(error=>{console.error(error.message);process.exitCode=1;});
