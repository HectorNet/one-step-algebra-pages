import bank from '../assets/question-bank.json' with {type:'json'};
import {createTutorService} from './tutor-service.mjs';
export default createTutorService({bank});
