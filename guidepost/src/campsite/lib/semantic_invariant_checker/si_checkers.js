import {log, llm} from '../utils.ts';

export const NLARTIFACT = "NL->Artifact"
export const NLIR = "NL->IR"
export const IRARTIFACT = "IR->Artifact"

export const VIOLATION_TYPE = Object.freeze({
    MALFORMED_HYPOTHESIS: "malformed_hypothesis",
    INTENT_VIOLATION: "intent_violation",
    STRUCTURE_VIOLATION: "structure_violation",
    UNCERTAINTY_SEMANTICS_VIOLATION: "uncertainty_semantics_violation",
    CROSS_REPRESENTATION_VIOLATION: "cross_representation_violation"
})

const CRITICALITY_TYPES = Object.freeze({
    WARN: "warn",
    FAIL: "fail"
})

class Invariant {
  constructor({ id, appliesTo }) {
    this.id = id;
    this.appliesTo = appliesTo; // ["NL"], ["IR"], ["ARTIFACT"] or any pairwise association
  }

  check({ ir = null, artifact = null, nl = null }) {
    throw new Error("Invariant.check() must be implemented");
  }
}

class Violation {
    constructor({
        invariantID,
        violationType,
        message,
        criticality,
        expected = null,
        observed
    }) {
        this.invariantID = invariantID;
        this.violationType = violationType;
        this.message = message;
        this.criticality = criticality;
        this.expected = expected;
        this.observed = observed;
    }
}

export class HypWellFormed extends Invariant {
    constructor({ id, appliesTo }) {
        super({ id, appliesTo });
        this.valid_comparators = ["=", ">", "<", ">=", "<=", "!=", "BETWEEN", "IN"]
    }

    is_reference_incompatible(ir){
        if(!ir.event.reference){
            return true;
        }

        //if event is a contrast or expectation
        // return true if comparision is not a number
        if(ir.event.quantity.type === 'contrast' || ir.event.quantity.type === 'expectation'){
            if(typeof(ir.event.reference.value) !== 'number'){ 
                return true;
            }
        }

        if(ir.event.quantity.type === "rv"){
            if(typeof(ir.event.reference.value) !== typeof([])){
                return true;
            }
        }

        return false;
    }

    check({ ir }) {
        let violations = [];

        log("IN VIOLATIONS CHECK:" + JSON.stringify(ir) + '\n')

        //Explicitly Well Formed Check
        // See: WF-1 in reference sheet
        if(!ir.event                    //no event present
            || !ir.event.quantity       //no qunatity present
            || !ir.event.comparator     //no comparator present
            || !ir.event.reference){    //no reference present
            violations.push({
                invariantID: "WF-1",
                violationType: VIOLATION_TYPE.MALFORMED_HYPOTHESIS,
                message: "Formal hypothesis representation missing one or more fundamental event.",
                criticality: CRITICALITY_TYPES.WARN,
                observed: ir
            })
        }

        //Comparator Check
        // See: WF-2 in reference sheet
        if(!this.valid_comparators.includes(ir.event.comparator)){ //if comparator is not in the set of valid comparators
            violations.push({
                invariantID: "WF-2",
                violationType: VIOLATION_TYPE.MALFORMED_HYPOTHESIS,
                message: `Invalid comparator: "${ir.event.comparator}".`,
                criticality: CRITICALITY_TYPES.WARN,
                observed: ir
            })
        }

        //Reference Compatability Check
        // See: WF-3 in reference sheet
        if(this.is_reference_incompatible(ir)){
            violations.push({
                invariantID: "WF-3",
                violationType: VIOLATION_TYPE.MALFORMED_HYPOTHESIS,
                message: "Reference value type is incompatable with quantity of interest.",
                criticality: CRITICALITY_TYPES.WARN,
                observed: ir
            })
        }

        return violations;
    }
}

//will return to this one
export class IntentPreserved extends Invariant{
    constructor({ id, appliesTo }) {
        super({ id, appliesTo });
    }

    async check({ir, nl, artifact}){
        let violations = [];

        log("\nRESPONSE: "+resp+"\n");

        if(this.appliesTo === NLIR){ //this is the NL->IR comnparision case
            //Comparator Polarity Preservation
            // See: INT-1 in reference sheet
            let resp = await llm.invoke(`You will be provided with a natural language hypothesis. 
                Please extract a comparator that describes the relationship between a quantity of interest and a reference value that the hypothesis is attempting to capture.
                Natural Language Hypothesis: ${nl}

                Return a json object with the following fields:
                {
                    comparator: <the comparator implied by the natural language hypothesis>,
                    rationale: <a short statement explaining your rationale for choosing this comparator>
                }
            `);

            resp = JSON.parse(resp).content;

            log("\nRESPONSE: "+resp+"\n");


            if(resp["comparator"] !== ir.event.comparator){
                violations.push({
                    invariantID: "INT-1",
                    violationType: VIOLATION_TYPE.INTENT_VIOLATION,
                    message: `Comparator polarity not maintained. LLM Rationale for NL comparator choice:${resp["rationale"]}`,
                    expected: resp["comparator"],
                    observed: ir.event.comparator,
                    criticality: CRITICALITY_TYPES.WARN
                })
            }

        }

        return violations;
    }
}


export class StructurePreserved extends Invariant{
    constructor({id, appliesTo}){
        super({id, appliesTo});
    }


    is_predicate_missing(ir){
        if(ir.event.quantity.type === "expectation" && !ir.event.quantity.predicate){
            return true;
        }
        else if(ir.event.quantity.type === "contrast"){
            if(!ir.event.quantity.left.predicate || !ir.event.quantity.right.predicate){
                return true
            }
        }
        else if(ir.event.quantity.type === "rv"){
            if(ir.event.quantity.estimand.type === "expectation" && !ir.event.quantity.estimand.predicate){
                return true
            }
            else if (ir.event.quantity.estimand.type === "contrast" && (!ir.event.quantity.estimand.left.predicate || !ir.event.quantity.estimand.right.predicate)){
                return true;
            }
        }

        return false;
    }

    is_algebraic_structure_not_preserved(ir){
        if(ir.event.quantity.type === "contrast" && (
            !ir.event.quantity.op
            || !ir.event.quantity.left
            || !ir.event.quantity.right)){
            return true;
        }
        else if(ir.event.quantity.type === "rv" 
                && (!ir.event.quantity.estimand.op
                || !ir.event.quantity.estimand.left
                || !ir.event.quantity.estimand.right)){
            return true;
        }

        return false;
    }

    check({ir}){
        let violations = [];

        // Explicit Estimand Check
        // See: STR-1 in reference sheet
        if(ir.event.quantity.type !== "contrast" 
            || ir.event.quantity.type !== "expectation"
            || ir.event.quantity.type !== "rv"
            || (ir.event.quantity.type === "rv" && !ir.event.quantity.estimand)){
            
            violations.push({
                invariantID: "STR-1",
                violationType: VIOLATION_TYPE.STRUCTURE_VIOLATION,
                message: "Estimand not explicitly present.",
                criticality: CRITICALITY_TYPES.FAIL,
                observed: ir
            })
        }

        // Explicit conditioning
        // See: STR-2 in reference sheet
        if(this.is_predicate_missing(ir)){
            violations.push({
                invariantID: "STR-2",
                violationType: VIOLATION_TYPE.STRUCTURE_VIOLATION,
                message: "Conditioning predicates are not attached to estimand.",
                criticality: CRITICALITY_TYPES.FAIL,
                observed: ir
            })
        }

        // Algebraic Structure Explictness
        // See: STR-3 in reference sheet
        if(this.is_algebraic_structure_not_preserved(ir)){
            violations.push({
                invariantID: "STR-3",
                violationType: VIOLATION_TYPE.STRUCTURE_VIOLATION,
                message: "Algebraic structure not explicitly preserved.",
                criticality: CRITICALITY_TYPES.FAIL,
                observed: ir
            })
        
        }
        
        

        return violations;
    }


}