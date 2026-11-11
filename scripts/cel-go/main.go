// Test-only independent comparator. No BVE evaluator or expression rewriting.
package main

import (
	"encoding/json"
	"fmt"
	"github.com/google/cel-go/cel"
	"github.com/google/cel-go/common/types"
	"os"
)

type Case struct {
	Name       string `json:"name"`
	Expression string `json:"expression"`
	Entity     any    `json:"entity"`
}

func main() {
	var cases []Case
	if err := json.NewDecoder(os.Stdin).Decode(&cases); err != nil {
		panic(err)
	}
	env, err := cel.NewEnv(cel.Variable("entity", cel.MapType(cel.StringType, cel.DynType)))
	if err != nil {
		panic(err)
	}
	rows := []map[string]any{}
	for _, c := range cases {
		row := map[string]any{"name": c.Name}
		ast, issues := env.Parse(c.Expression)
		if issues != nil && issues.Err() != nil {
			row["outcome"] = "parse"
		} else {
			checked, issues := env.Check(ast)
			if issues != nil && issues.Err() != nil {
				row["outcome"] = "check"
			} else {
				program, err := env.Program(checked)
				if err != nil {
					panic(err)
				}
				// encoding/json decodes each JSON number as float64, which CEL-Go maps to double.
				result, _, err := program.Eval(map[string]any{"entity": c.Entity})
				if err != nil || types.IsError(result) {
					row["outcome"] = "evaluation"
				} else if b, ok := result.Value().(bool); ok {
					row["outcome"] = b
				} else {
					row["outcome"] = "result_type"
					row["rawType"] = result.Type().TypeName()
					row["rawValue"] = result.Value()
				}
			}
		}
		rows = append(rows, row)
	}
	data, err := json.MarshalIndent(rows, "", "  ")
	if err != nil {
		panic(err)
	}
	fmt.Println(string(data))
}
