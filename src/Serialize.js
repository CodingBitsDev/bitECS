import { $indexBytes, $indexType, $serializeShadow, $storeBase, $storeFlattened, $tagStore } from "./Storage.js"
import { $componentMap, addComponent, hasComponent } from "./Component.js"
import { $entityArray, $entityEnabled, addEntity } from "./Entity.js"

let resized = false

export const setSerializationResized = v => { resized = v }

const canonicalize = (target) => {
  let componentProps = []
  let changedProps = new Set()
  if (Array.isArray(target)) {
    componentProps = target
      .map(p => {
        if (typeof p === 'function' && p.name === 'QueryChanged') {
          p()[$storeFlattened].forEach(prop => {
            changedProps.add(prop)
          })
          return p()[$storeFlattened]
        }
        if (Object.getOwnPropertySymbols(p).includes($storeFlattened)) {
          return p[$storeFlattened]
        }
        if (Object.getOwnPropertySymbols(p).includes($storeBase)) {
          return p
        }
      })
      .reduce((a,v) => a.concat(v), [])
  }
  return [componentProps, changedProps]
}

export const defineSerializer = (target, maxBytes = 20000000) => {
  const isWorld = Object.getOwnPropertySymbols(target).includes($componentMap)

  let [componentProps, changedProps] = canonicalize(target)

  // TODO: calculate max bytes based on target

  const buffer = new ArrayBuffer(maxBytes)
  const view = new DataView(buffer)

  return ents => {

    if (resized) {
      [componentProps, changedProps] = canonicalize(target)
      resized = false
    }

    if (isWorld) {
      componentProps = []
      target[$componentMap].forEach((c, component) => {
        componentProps.push(...component[$storeFlattened])
      })
    }
    
    if (Object.getOwnPropertySymbols(ents).includes($componentMap)) {
      ents = ents[$entityArray]
    }

    if (!ents.length) return

    let where = 0

    // iterate over component props
    for (let pid = 0; pid < componentProps.length; pid++) {
      const prop = componentProps[pid]
      const diff = changedProps.has(prop)
      
      // write pid
      view.setUint8(where, pid)
      where += 1

      // save space for entity count
      const countWhere = where
      where += 4
      
      let count = 0
      // write eid,val
      for (let i = 0; i < ents.length; i++) {
        const eid = ents[i]

        // skip if diffing and no change
        if (diff && prop[eid] === prop[$serializeShadow][eid]) {
          continue
        }
        
        count++

        // write eid
        view.setUint32(where, eid)
        where += 4

        if (prop[$tagStore]) {
          continue
        }

        // if property is an array
        if (ArrayBuffer.isView(prop[eid])) {
          const type = prop[eid].constructor.name.replace('Array', '')
          const indexType = prop[eid][$indexType]
          const indexBytes = prop[eid][$indexBytes]

          // add space for count of dirty array elements
          const countWhere2 = where
          where += 1

          let count2 = 0

          // write index,value
          for (let i = 0; i < prop[eid].length; i++) {
            const value = prop[eid][i]

            if (diff && prop[eid][i] === prop[eid][$serializeShadow][i]) {
              continue
            }

            // write array index
            view[`set${indexType}`](where, i)
            where += indexBytes

            // write value at that index
            view[`set${type}`](where, value)
            where += prop[eid].BYTES_PER_ELEMENT
            count2++
          }

          // write total element count
          view[`set${indexType}`](countWhere2, count2)

        } else {
          // regular property values
          const type = prop.constructor.name.replace('Array', '')
          // set value next [type] bytes
          view[`set${type}`](where, prop[eid])
          where += prop.BYTES_PER_ELEMENT

          // sync shadow state
          prop[$serializeShadow][eid] = prop[eid]
        }
      }

      view.setUint32(countWhere, count)
    }
    return buffer.slice(0, where)
  }
}

export const defineDeserializer = (target) => {
  const isWorld = Object.getOwnPropertySymbols(target).includes($componentMap)
  let [componentProps] = canonicalize(target)
  return (world, packet) => {
    
    if (resized) {
      [componentProps] = canonicalize(target)
      resized = false
    }

    if (isWorld) {
      componentProps = []
      target[$componentMap].forEach((c, component) => {
        componentProps.push(...component[$storeFlattened])
      })
    }

    const view = new DataView(packet)
    let where = 0

    while (where < packet.byteLength) {

      // pid
      const pid = view.getUint8(where)
      where += 1

      // entity count
      const entityCount = view.getUint32(where)
      where += 4

      // typed array
      const ta = componentProps[pid]

      // Get the properties and set the new state
      for (let i = 0; i < entityCount; i++) {
        let eid = view.getUint32(where)
        where += 4

        // if this world hasn't seen this eid yet
        if (!world[$entityEnabled][eid]) {
          // make a new entity for the data
          eid = addEntity(world)
        }

        const component = ta[$storeBase]()
        if (!hasComponent(world, component, eid)) {
          addComponent(world, component, eid)
        }

        if (component[$tagStore]) {
          continue
        }
        
        if (ArrayBuffer.isView(ta[eid])) {
          const array = ta[eid]
          const count = view[`get${array[$indexType]}`](where)
          where += array[$indexBytes]

          // iterate over count
          for (let i = 0; i < count; i++) {
            const index = view[`get${array[$indexType]}`](where)
            where += array[$indexBytes]

            const value = view[`get${array.constructor.name.replace('Array', '')}`](where)
            where += array.BYTES_PER_ELEMENT

            ta[eid][index] = value
          }
        } else {
          const value = view[`get${ta.constructor.name.replace('Array', '')}`](where)
          where += ta.BYTES_PER_ELEMENT

          ta[eid] = value
        }
      }
    }
  }
}